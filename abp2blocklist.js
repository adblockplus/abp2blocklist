"use strict";

let readline = require("readline");
let punycode = require("punycode");
let tldjs = require("tldjs");
let filterClasses = require("./adblockplus.js");

let typeMap = filterClasses.RegExpFilter.typeMap;

const selectorLimit = 5000;

let requestFilters = [];
let requestExceptions = [];
let elemhideFilters = [];
let elemhideExceptions = [];
let elemhideSelectorExceptions = new Map();

function recordException(filter)
{
  if (filter.contentType & (typeMap.IMAGE
                            | typeMap.STYLESHEET
                            | typeMap.SCRIPT
                            | typeMap.FONT
                            | typeMap.MEDIA
                            | typeMap.POPUP
                            | typeMap.OBJECT
                            | typeMap.OBJECT_SUBREQUEST
                            | typeMap.XMLHTTPREQUEST
                            | typeMap.PING
                            | typeMap.SUBDOCUMENT
                            | typeMap.OTHER))
    requestExceptions.push(filter);

    if (filter.contentType & typeMap.ELEMHIDE)
      elemhideExceptions.push(filter);
}

function parseDomains(domains, included, excluded)
{
  for (let domain in domains)
  {
    if (domain != "")
    {
      let enabled = domains[domain];
      domain = punycode.toASCII(domain.toLowerCase());

      if (!enabled)
        excluded.push(domain);
      else if (!domains[""])
        included.push(domain);
    }
  }
}

function recordSelectorException(filter)
{
  let domains = elemhideSelectorExceptions[filter.selector];
  if (!domains)
    domains = elemhideSelectorExceptions[filter.selector] = [];

  parseDomains(filter.domains, domains, []);
}

function parseFilter(line)
{
  if (line.charAt(0) == "[")
    return;

  let filter = filterClasses.Filter.fromText(line);

  if (filter.sitekeys)
    return;
  if (filter instanceof filterClasses.RegExpFilter && !filter.regexpSource)
    return;

  if (filter instanceof filterClasses.BlockingFilter)
    requestFilters.push(filter);
  if (filter instanceof filterClasses.WhitelistFilter)
    recordException(filter);
  if (filter instanceof filterClasses.ElemHideFilter)
    elemhideFilters.push(filter);
  if (filter instanceof filterClasses.ElemHideException)
    recordSelectorException(filter);
}

function escapeRegExp(s)
{
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchDomain(domain)
{
  return "^https?://([^/:]*\\.)?" + escapeRegExp(domain) + "[/:]";
}

function convertElemHideFilter(filter)
{
  let included = [];
  let excluded = [];
  let rules = [];

  parseDomains(filter.domains, included, excluded);

  if (excluded.length == 0 && !(filter.selector in elemhideSelectorExceptions))
    return {matchDomains: included.map(matchDomain), selector: filter.selector};
}

function toRegExp(text)
{
  let result = "";
  let lastIndex = text.length - 1;

  for (let i = 0; i < text.length; i++)
  {
    let c = text[i];

    switch (c)
    {
      case "*":
        if (result.length > 0 && i < lastIndex && text[i + 1] != "*")
          result += ".*";
        break;
      case "^":
        if (i < lastIndex)
          result += ".";
        break;
      case "|":
        if (i == 0)
        {
          result += "^";
          break;
        }
        if (i == lastIndex)
        {
          result += "$";
          break;
        }
        if (i == 1 && text[0] == "|")
        {
          result += "https?://";
          break;
        }
      case ".": case "+": case "?": case "$":
      case "{": case "}": case "(": case ")":
      case "[": case "]": case "\\":
        result += "\\";
      default:
        result += c;
    }
  }

  return result;
}

function getRegExpSource(filter)
{
  let source = toRegExp(filter.regexpSource.replace(
    // Safari expects punycode, filter lists use unicode
    /^(\|\||\|?https?:\/\/)([\w\-.*\u0080-\uFFFF]+)/i,
    function (match, prefix, domain)
    {
      return prefix + punycode.toASCII(domain);
    }
  ));

  // Limit rules to to HTTP(S) URLs
  if (!/^(\^|http)/i.test(source))
    source = "^https?://.*" + source;

  return source;
}

function getResourceTypes(filter)
{
  let types = [];

  if (filter.contentType & typeMap.IMAGE)
    types.push("image");
  if (filter.contentType & typeMap.STYLESHEET)
    types.push("style-sheet");
  if (filter.contentType & typeMap.SCRIPT)
    types.push("script");
  if (filter.contentType & typeMap.FONT)
    types.push("font");
  if (filter.contentType & (typeMap.MEDIA | typeMap.OBJECT))
    types.push("media");
  if (filter.contentType & typeMap.POPUP)
    types.push("popup");
  if (filter.contentType & (typeMap.XMLHTTPREQUEST | typeMap.OBJECT_SUBREQUEST
      | typeMap.PING | typeMap.OTHER))
    types.push("raw");
  if (filter.contentType & typeMap.SUBDOCUMENT)
    types.push("document");

  return types;
}

function addDomainPrefix(domains)
{
  let result = [];

  for (let domain of domains)
  {
    result.push(domain);

    if (tldjs.getSubdomain(domain) == "")
      result.push("www." + domain);
  }

  return result;
}

function convertFilter(filter, action, withResourceTypes)
{
  let trigger = {"url-filter": getRegExpSource(filter)};
  let included = [];
  let excluded = [];

  parseDomains(filter.domains, included, excluded);

  if (withResourceTypes)
    trigger["resource-type"] = getResourceTypes(filter);
  if (filter.thirdParty != null)
    trigger["load-type"] = [filter.thirdParty ? "third-party" : "first-party"];

  if (included.length > 0)
    trigger["if-domain"] = addDomainPrefix(included);
  else if (excluded.length > 0)
    trigger["unless-domain"] = addDomainPrefix(excluded);

  return {trigger: trigger, action: {type: action}};
}

function hasNonASCI(obj)
{
  if (typeof obj == "string")
  {
    if (/[^\x00-\x7F]/.test(obj))
      return true;
  }

  if (typeof obj == "object")
  {
    if (obj instanceof Array)
      for (let item of obj)
        if (hasNonASCI(item))
          return true;

    for (let name of Object.getOwnPropertyNames(obj))
      if (hasNonASCI(obj[name]))
        return true;
  }

  return false;
}

function convertIDSelectorsToAttributeSelectors(selector)
{
  // First we figure out where all the IDs are
  let sep = "";
  let start = null;
  let positions = [];
  for (let i = 0; i < selector.length; i++)
  {
    let chr = selector[i];

    if (chr == "\\")        // ignore escaped characters
      i++;
    else if (chr == sep)    // don't match IDs within quoted text
      sep = "";             // e.g. [attr="#Hello"]
    else if (sep == "")
    {
      if (chr == '"' || chr == "'")
        sep = chr;
      else if (start == null)  // look for the start of an ID
      {
        if (chr == "#")
          start = i;
      }
      else if (chr != "-" && chr != "_" &&
               (chr < "0" ||
                chr > "9" && chr < "A" ||
                chr > "Z" && chr < "a" ||
                chr > "z" && chr < "\x80")) // look for the end of the ID
      {
        positions.push({start: start, end: i});
        start = null;
      }
    }
  }
  if (start != null)
    positions.push({start: start, end: selector.length});

  // Now replace them all with the [id="someID"] form
  let newSelector = [];
  let i = 0;
  for (let pos of positions)
  {
    newSelector.push(selector.substring(i, pos.start));
    newSelector.push('[id=' + selector.substring(pos.start + 1, pos.end) + ']');
    i = pos.end;
  }
  newSelector.push(selector.substring(i));

  return newSelector.join("");
}

function logRules()
{
  let rules = [];

  function addRule(rule)
  {
    if (!hasNonASCI(rule))
      rules.push(rule);
  }

  let groupedElemhideFilters = new Map();
  for (let filter of elemhideFilters)
  {
    let result = convertElemHideFilter(filter);
    if (!result)
      continue;

    if (result.matchDomains.length == 0)
      result.matchDomains = ["^https?://"];

    for (let matchDomain of result.matchDomains)
    {
      let group = groupedElemhideFilters.get(matchDomain) || [];
      group.push(result.selector);
      groupedElemhideFilters.set(matchDomain, group);
    }
  }

  groupedElemhideFilters.forEach((selectors, matchDomain) =>
  {
    while (selectors.length)
    {
      let selector = selectors.splice(0, selectorLimit).join(", ");

      // As of Safari 9.0 element IDs are matched as lowercase. We work around
      // this by converting to the attribute format [id="elementID"]
      selector = convertIDSelectorsToAttributeSelectors(selector);

      addRule({
        trigger: {"url-filter": matchDomain},
        action: {type: "css-display-none",
                 selector: selector}
      });
    }
  });

  for (let filter of elemhideExceptions)
    addRule(convertFilter(filter, "ignore-previous-rules", false));

  for (let filter of requestFilters)
    addRule(convertFilter(filter, "block", true));
  for (let filter of requestExceptions)
    addRule(convertFilter(filter, "ignore-previous-rules", true));

  console.log(JSON.stringify(rules, null, "\t"));
}

let rl = readline.createInterface({input: process.stdin, terminal: false});
rl.on("line", parseFilter);
rl.on("close", logRules);
