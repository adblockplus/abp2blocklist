/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-2017 eyeo GmbH
 *
 * Adblock Plus is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Adblock Plus is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Adblock Plus.  If not, see <http://www.gnu.org/licenses/>.
 */

/** @module abp2blocklist */

"use strict";

let filterClasses = require("filterClasses");
let punycode = require("punycode");

const selectorLimit = 5000;
const typeMap = filterClasses.RegExpFilter.typeMap;
const whitelistableRequestTypes = (typeMap.IMAGE
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
                                   | typeMap.OTHER);

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

function escapeRegExp(s)
{
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchDomain(domain)
{
  return "^https?://([^/:]*\\.)?" + escapeRegExp(domain).toLowerCase() + "[/:]";
}

function findSubdomainsInList(domain, list)
{
  let subdomains = [];
  let suffixLength = domain.length + 1;

  for (let name of list)
  {
    if (name.length > suffixLength && name.slice(-suffixLength) == "." + domain)
      subdomains.push(name.slice(0, -suffixLength));
  }

  return subdomains;
}

function extractFilterDomains(filters)
{
  let domains = new Set();
  for (let filter of filters)
  {
    let parsed = parseFilterRegexpSource(filter.regexpSource);
    if (parsed.justHostname)
      domains.add(parsed.hostname);
  }
  return domains;
}

function convertElemHideFilter(filter, elemhideSelectorExceptions)
{
  let included = [];
  let excluded = [];
  let rules = [];

  parseDomains(filter.domains, included, excluded);

  if (excluded.length == 0 && !(filter.selector in elemhideSelectorExceptions))
    return {matchDomains: included.map(matchDomain), selector: filter.selector};
}

/**
 * Parse the given filter "regexpSource" string. Producing a regular expression,
 * extracting the hostname (if any), deciding if the regular expression is safe
 * to be converted + matched as lower case and noting if the source contains
 * anything after the hostname.)
 *
 * @param   {string} text regexpSource property of a filter
 * @returns {object} An object containing a regular expression string, a bool
 *                   indicating if the filter can be safely matched as lower
 *                   case, a hostname string (or undefined) and a bool
 *                   indicating if the source only contains a hostname or not:
 *                     {regexp: "...",
 *                      canSafelyMatchAsLowercase: true/false,
 *                      hostname: "...",
 *                      justHostname: true/false}
 */
function parseFilterRegexpSource(text)
{
  let regexp = [];

  // Convert the text into an array of Unicode characters.
  //
  // In the case of surrogate pairs (the smiley emoji, for example), one
  // Unicode code point is represented by two JavaScript characters together.
  // We want to iterate over Unicode code points rather than JavaScript
  // characters.
  let characters = Array.from(text);

  let lastIndex = characters.length - 1;
  let hostname;
  let hostnameStart = null;
  let hostnameFinished = false;
  let justHostname = false;
  let canSafelyMatchAsLowercase = false;

  for (let i = 0; i < characters.length; i++)
  {
    let c = characters[i];

    if (hostnameFinished)
      justHostname = false;

    // If we're currently inside the hostname we have to be careful not to
    // escape any characters until after we have converted it to punycode.
    if (hostnameStart != null && !hostnameFinished)
    {
      let endingChar = (c == "*" || c == "^" ||
                        c == "?" || c == "/" || c == "|");
      if (!endingChar && i != lastIndex)
        continue;

      hostname = punycode.toASCII(
        characters.slice(hostnameStart, endingChar ? i : i + 1).join("")
                  .toLowerCase()
      );
      hostnameFinished = justHostname = true;
      regexp.push(escapeRegExp(hostname));
      if (!endingChar)
        break;
    }

    switch (c)
    {
      case "*":
        if (regexp.length > 0 && i < lastIndex && characters[i + 1] != "*")
          regexp.push(".*");
        break;
      case "^":
        if (i < lastIndex)
          regexp.push(".");
        break;
      case "|":
        if (i == 0)
        {
          regexp.push("^");
          break;
        }
        if (i == lastIndex)
        {
          regexp.push("$");
          break;
        }
        if (i == 1 && characters[0] == "|")
        {
          hostnameStart = i + 1;
          canSafelyMatchAsLowercase = true;
          regexp.push("https?://([^/]+\\.)?");
          break;
        }
        regexp.push("\\|");
        break;
      case "/":
        if (!hostnameFinished &&
            characters[i - 2] == ":" && characters[i - 1] == "/")
        {
          hostnameStart = i + 1;
          canSafelyMatchAsLowercase = true;
        }
        regexp.push("/");
        break;
      case ".": case "+": case "$": case "?":
      case "{": case "}": case "(": case ")":
      case "[": case "]": case "\\":
        regexp.push("\\", c);
        break;
      default:
        if (hostnameFinished && (c >= "a" && c <= "z" ||
                                 c >= "A" && c <= "Z"))
          canSafelyMatchAsLowercase = false;
        regexp.push(c == "%" ? c : encodeURI(c));
    }
  }

  return {
    regexp: regexp.join(""),
    canSafelyMatchAsLowercase: canSafelyMatchAsLowercase,
    hostname: hostname,
    justHostname: justHostname
  };
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
  if (filter.contentType & (typeMap.XMLHTTPREQUEST |
                            typeMap.OBJECT_SUBREQUEST |
                            typeMap.PING |
                            typeMap.OTHER))
    types.push("raw");
  if (filter.contentType & typeMap.SUBDOCUMENT)
    types.push("document");

  return types;
}

function convertFilterAddRules(rules, filter, action, withResourceTypes,
                               exceptionDomains)
{
  let parsed = parseFilterRegexpSource(filter.regexpSource);

  // For the special case of $document whitelisting filters with just a domain
  // we can generate an equivalent blocking rule exception using if-domain.
  if (filter instanceof filterClasses.WhitelistFilter &&
      filter.contentType & typeMap.DOCUMENT &&
      parsed.justHostname)
  {
    rules.push({
      trigger: {
        "url-filter": ".*",
        "if-domain": ["*" + parsed.hostname]
      },
      action: {type: "ignore-previous-rules"}
    });
    // If the filter contains other supported options we'll need to generate
    // further rules for it, but if not we can simply return now.
    if (!(filter.contentType & whitelistableRequestTypes))
      return;
  }

  let trigger = {"url-filter": parsed.regexp};

  // Limit rules to HTTP(S) URLs
  if (!/^(\^|http)/i.test(trigger["url-filter"]))
    trigger["url-filter"] = "^https?://.*" + trigger["url-filter"];

  // For rules containing only a hostname we know that we're matching against
  // a lowercase string unless the matchCase option was passed.
  if (parsed.canSafelyMatchAsLowercase && !filter.matchCase)
    trigger["url-filter"] = trigger["url-filter"].toLowerCase();

  if (parsed.canSafelyMatchAsLowercase || filter.matchCase)
    trigger["url-filter-is-case-sensitive"] = true;

  let included = [];
  let excluded = [];

  parseDomains(filter.domains, included, excluded);

  if (exceptionDomains)
    excluded = excluded.concat(exceptionDomains);

  if (withResourceTypes)
  {
    let resourceTypes = getResourceTypes(filter);

    // Content blocker rules can't differentiate between sub-document requests
    // (iframes) and top-level document requests. To avoid too many false
    // positives, we prevent rules with no hostname part from blocking document
    // requests.
    //
    // Once Safari 11 becomes our minimum supported version, we could change
    // our approach here to use the new "unless-top-url" property instead.
    if (filter instanceof filterClasses.BlockingFilter && !parsed.hostname)
      resourceTypes = resourceTypes.filter(type => type != "document");

    if (resourceTypes.length == 0)
      return;

    trigger["resource-type"] = resourceTypes;
  }

  if (filter.thirdParty != null)
    trigger["load-type"] = [filter.thirdParty ? "third-party" : "first-party"];

  if (included.length > 0)
  {
    trigger["if-domain"] = [];

    for (let name of included)
    {
      // If this is a blocking filter or an element hiding filter, add the
      // subdomain wildcard only if no subdomains have been excluded.
      let notSubdomains = null;
      if ((filter instanceof filterClasses.BlockingFilter ||
           filter instanceof filterClasses.ElemHideFilter) &&
          (notSubdomains = findSubdomainsInList(name, excluded)).length > 0)
      {
        trigger["if-domain"].push(name);

        // Add the "www" prefix but only if it hasn't been excluded.
        if (!notSubdomains.includes("www"))
          trigger["if-domain"].push("www." + name);
      }
      else
      {
        trigger["if-domain"].push("*" + name);
      }
    }
  }
  else if (excluded.length > 0)
  {
    trigger["unless-domain"] = excluded.map(name => "*" + name);
  }
  else if (filter instanceof filterClasses.BlockingFilter &&
           filter.contentType & typeMap.SUBDOCUMENT && parsed.hostname)
  {
    // Rules with a hostname part are still allowed to block document requests,
    // but we add an exception for top-level documents.
    //
    // Note that we can only do this if there's no "unless-domain" property for
    // now. This also only works in Safari 11 onwards, while older versions
    // simply ignore this property. Once Safari 11 becomes our minimum
    // supported version, we can merge "unless-domain" into "unless-top-url".
    trigger["unless-top-url"] = [trigger["url-filter"]];
    if (trigger["url-filter-is-case-sensitive"])
      trigger["top-url-filter-is-case-sensitive"] = true;
  }

  rules.push({trigger: trigger, action: {type: action}});
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
    newSelector.push('[id=', selector.substring(pos.start + 1, pos.end), ']');
    i = pos.end;
  }
  newSelector.push(selector.substring(i));

  return newSelector.join("");
}

function addCSSRules(rules, selectors, matchDomain, exceptionDomains)
{
  let unlessDomain = exceptionDomains.size > 0 ? [] : null;

  exceptionDomains.forEach(name => unlessDomain.push("*" + name));

  while (selectors.length)
  {
    let selector = selectors.splice(0, selectorLimit).join(", ");

    // As of Safari 9.0 element IDs are matched as lowercase. We work around
    // this by converting to the attribute format [id="elementID"]
    selector = convertIDSelectorsToAttributeSelectors(selector);

    let rule = {
      trigger: {"url-filter": matchDomain,
                "url-filter-is-case-sensitive": true},
      action: {type: "css-display-none",
               selector: selector}
    };

    if (unlessDomain)
      rule.trigger["unless-domain"] = unlessDomain;

    rules.push(rule);
  }
}

let ContentBlockerList =
/**
 * Create a new Adblock Plus filter to content blocker list converter
 *
 * @constructor
 */
exports.ContentBlockerList = function ()
{
  this.requestFilters = [];
  this.requestExceptions = [];
  this.elemhideFilters = [];
  this.elemhideExceptions =  [];
  this.genericblockExceptions = [];
  this.generichideExceptions = [];
  this.elemhideSelectorExceptions = new Map();
};

/**
 * Add Adblock Plus filter to be converted
 *
 * @param {Filter} filter Filter to convert
 */
ContentBlockerList.prototype.addFilter = function(filter)
{
  if (filter.sitekeys)
    return;
  if (filter instanceof filterClasses.RegExpFilter &&
      filter.regexpSource == null)
    return;

  if (filter instanceof filterClasses.BlockingFilter)
    this.requestFilters.push(filter);

  if (filter instanceof filterClasses.WhitelistFilter)
  {
    if (filter.contentType & (typeMap.DOCUMENT | whitelistableRequestTypes))
      this.requestExceptions.push(filter);

    if (filter.contentType & typeMap.GENERICBLOCK)
      this.genericblockExceptions.push(filter);

    if (filter.contentType & typeMap.ELEMHIDE)
      this.elemhideExceptions.push(filter);
    else if (filter.contentType & typeMap.GENERICHIDE)
      this.generichideExceptions.push(filter);
  }

  if (filter instanceof filterClasses.ElemHideFilter)
    this.elemhideFilters.push(filter);

  if (filter instanceof filterClasses.ElemHideException)
  {
    let domains = this.elemhideSelectorExceptions[filter.selector];
    if (!domains)
      domains = this.elemhideSelectorExceptions[filter.selector] = [];

    parseDomains(filter.domains, domains, []);
  }
};

/**
 * Generate content blocker list for all filters that were added
 *
 * @returns   {Filter}   filter    Filter to convert
 */
ContentBlockerList.prototype.generateRules = function(filter)
{
  let rules = [];

  let genericSelectors = [];
  let groupedElemhideFilters = new Map();

  for (let filter of this.elemhideFilters)
  {
    let result = convertElemHideFilter(filter, this.elemhideSelectorExceptions);
    if (!result)
      continue;

    if (result.matchDomains.length == 0)
    {
      genericSelectors.push(result.selector);
    }
    else
    {
      for (let matchDomain of result.matchDomains)
      {
        let group = groupedElemhideFilters.get(matchDomain) || [];
        group.push(result.selector);
        groupedElemhideFilters.set(matchDomain, group);
      }
    }
  }

  // Separate out the element hiding exceptions that have only a hostname part
  // from the rest. This allows us to implement a workaround for issue #5345
  // (WebKit bug #167423), but as a bonus it also reduces the number of
  // generated rules. The downside is that the exception will only apply to the
  // top-level document, not to iframes. We have to live with this until the
  // WebKit bug is fixed in all supported versions of Safari.
  // https://bugs.webkit.org/show_bug.cgi?id=167423
  //
  // Note that as a result of this workaround we end up with a huge rule set in
  // terms of the amount of memory used. This can cause Node.js to throw
  // "JavaScript heap out of memory". To avoid this, call Node.js with
  // --max_old_space_size=4096
  let elemhideExceptionDomains = extractFilterDomains(this.elemhideExceptions);

  let genericSelectorExceptionDomains =
    extractFilterDomains(this.generichideExceptions);
  elemhideExceptionDomains.forEach(name =>
  {
    genericSelectorExceptionDomains.add(name);
  });

  addCSSRules(rules, genericSelectors, "^https?://",
              genericSelectorExceptionDomains);

  groupedElemhideFilters.forEach((selectors, matchDomain) =>
  {
    addCSSRules(rules, selectors, matchDomain, elemhideExceptionDomains);
  });

  let requestFilterExceptionDomains = [];
  for (let filter of this.genericblockExceptions)
  {
    let parsed = parseFilterRegexpSource(filter.regexpSource);
    if (parsed.hostname)
      requestFilterExceptionDomains.push(parsed.hostname);
  }

  for (let filter of this.requestFilters)
  {
    convertFilterAddRules(rules, filter, "block", true,
                          requestFilterExceptionDomains);
  }

  for (let filter of this.requestExceptions)
    convertFilterAddRules(rules, filter, "ignore-previous-rules", true);

  return rules;
};
