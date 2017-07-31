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

const httpRequestTypes = typeMap.IMAGE |
                         typeMap.STYLESHEET |
                         typeMap.SCRIPT |
                         typeMap.FONT |
                         typeMap.MEDIA |
                         typeMap.POPUP |
                         typeMap.OBJECT |
                         typeMap.OBJECT_SUBREQUEST |
                         typeMap.XMLHTTPREQUEST |
                         typeMap.PING |
                         typeMap.SUBDOCUMENT |
                         typeMap.OTHER;
const rawRequestTypes = typeMap.XMLHTTPREQUEST |
                        typeMap.WEBSOCKET |
                        typeMap.WEBRTC |
                        typeMap.OBJECT_SUBREQUEST |
                        typeMap.PING |
                        typeMap.OTHER;
const whitelistableRequestTypes = httpRequestTypes |
                                  typeMap.WEBSOCKET |
                                  typeMap.WEBRTC;

function callLater(func)
{
  return new Promise(resolve =>
  {
    let call = () => resolve(func());

    // If this looks like Node.js, call process.nextTick, otherwise call
    // setTimeout.
    if (typeof process != "undefined")
      process.nextTick(call);
    else
      setTimeout(call, 0);
  });
}

function async(callees, mapFunction)
{
  if (!(Symbol.iterator in callees))
    callees = [callees];

  let lastPause = Date.now();
  let index = 0;

  let promise = Promise.resolve();

  for (let next of callees)
  {
    let currentIndex = index;

    promise = promise.then(() =>
    {
      if (mapFunction)
        next = mapFunction(next, currentIndex);

      // If it has been 100ms or longer since the last call, take a pause. This
      // keeps the browser from freezing up.
      let now = Date.now();
      if (now - lastPause >= 100)
      {
        lastPause = now;
        return callLater(next);
      }

      return next();
    });

    index++;
  }

  return promise;
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

function escapeRegExp(s)
{
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchDomain(domain)
{
  if (!domain)
    return "^https?://";

  return "^https?://([^/:]*\\.)?" + escapeRegExp(domain).toLowerCase() + "[/:]";
}

function getURLSchemes(contentType)
{
  // If the given content type includes all supported URL schemes, simply
  // return a single generic URL scheme pattern. This minimizes the size of the
  // generated rule set. The downside to this is that it will also match
  // schemes that we do not want to match (e.g. "ftp://"), but this can be
  // mitigated by adding exceptions for those schemes.
  if (contentType & typeMap.WEBSOCKET && contentType & typeMap.WEBRTC &&
      contentType & httpRequestTypes)
    return ["[^:]+:(//)?"];

  let urlSchemes = [];

  if (contentType & typeMap.WEBSOCKET)
    urlSchemes.push("wss?://");

  if (contentType & typeMap.WEBRTC)
    urlSchemes.push("stuns?:", "turns?:");

  if (contentType & httpRequestTypes)
    urlSchemes.push("https?://");

  return urlSchemes;
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

  parseDomains(filter.domains, included, excluded);

  if (excluded.length == 0 && !(filter.selector in elemhideSelectorExceptions))
    return {matchDomains: included, selector: filter.selector};
}

/**
 * Parse the given filter "regexpSource" string. Producing a regular expression,
 * extracting the hostname (if any), deciding if the regular expression is safe
 * to be converted + matched as lower case and noting if the source contains
 * anything after the hostname.)
 *
 * @param   {string} text regexpSource property of a filter
 * @param   {string} urlScheme The URL scheme to use in the regular expression
 * @returns {object} An object containing a regular expression string, a bool
 *                   indicating if the filter can be safely matched as lower
 *                   case, a hostname string (or undefined) and a bool
 *                   indicating if the source only contains a hostname or not:
 *                     {regexp: "...",
 *                      canSafelyMatchAsLowercase: true/false,
 *                      hostname: "...",
 *                      justHostname: true/false}
 */
function parseFilterRegexpSource(text, urlScheme)
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

  if (!urlScheme)
    urlScheme = getURLSchemes()[0];

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
        let alphabet = "a-z";
        // If justHostname is true and we've encountered a "^", it means we're
        // still in the hostname part of the URL. Since hostnames are always
        // lower case (Punycode), there's no need to include "A-Z" in the
        // pattern. Further, subsequent code may lower-case the entire regular
        // expression (if the URL contains only the hostname part), leaving us
        // with "a-za-z", which would be redundant.
        if (!justHostname)
          alphabet = "A-Z" + alphabet;
        let digits = "0-9";
        // Note that the "-" must appear first here in order to retain its
        // literal meaning within the brackets.
        let specialCharacters = "-_.%";
        let separator = "[^" + specialCharacters + alphabet + digits + "]";
        if (i == 0)
          regexp.push("^" + urlScheme + "(.*" + separator + ")?");
        else if (i == lastIndex)
          regexp.push("(" + separator + ".*)?$");
        else
          regexp.push(separator);
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
          regexp.push(urlScheme + "([^/]+\\.)?");
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

function getResourceTypes(contentType)
{
  let types = [];

  if (contentType & typeMap.IMAGE)
    types.push("image");
  if (contentType & typeMap.STYLESHEET)
    types.push("style-sheet");
  if (contentType & typeMap.SCRIPT)
    types.push("script");
  if (contentType & typeMap.FONT)
    types.push("font");
  if (contentType & (typeMap.MEDIA | typeMap.OBJECT))
    types.push("media");
  if (contentType & typeMap.POPUP)
    types.push("popup");
  if (contentType & rawRequestTypes)
    types.push("raw");
  if (contentType & typeMap.SUBDOCUMENT)
    types.push("document");

  return types;
}

function makeRuleCopies(trigger, action, urlSchemes)
{
  let copies = [];

  // Always make a deep copy of the rule, since rules may have to be
  // manipulated individually at a later stage.
  let stringifiedTrigger = JSON.stringify(trigger);

  let filterPattern = trigger["url-filter"].substring(1);
  let startIndex = 0;

  // If the URL filter already begins with the first URL scheme pattern, skip
  // it.
  if (trigger["url-filter"].startsWith("^" + urlSchemes[0]))
  {
    filterPattern = filterPattern.substring(urlSchemes[0].length);
    startIndex = 1;
  }
  else
  {
    filterPattern = ".*" + filterPattern;
  }

  for (let i = startIndex; i < urlSchemes.length; i++)
  {
    let copyTrigger = Object.assign(JSON.parse(stringifiedTrigger), {
      "url-filter": "^" + urlSchemes[i] + filterPattern
    });
    copies.push({trigger: copyTrigger, action});
  }

  return copies;
}

function excludeTopURLFromTrigger(trigger)
{
  trigger["unless-top-url"] = [trigger["url-filter"]];
  if (trigger["url-filter-is-case-sensitive"])
    trigger["top-url-filter-is-case-sensitive"] = true;
}

function convertFilterAddRules(rules, filter, action, withResourceTypes,
                               exceptionDomains, contentType)
{
  if (!contentType)
    contentType = filter.contentType;

  // If WebSocket or WebRTC are given along with other options but not
  // including all three of WebSocket, WebRTC, and at least one HTTP raw type,
  // we must generate multiple rules. For example, for the filter
  // "foo$websocket,image", we must generate one rule with "^wss?://" and "raw"
  // and another rule with "^https?://" and "image". If we merge the two, we
  // end up blocking requests of all HTTP raw types (e.g. XMLHttpRequest)
  // inadvertently.
  if ((contentType & typeMap.WEBSOCKET && contentType != typeMap.WEBSOCKET &&
       !(contentType & typeMap.WEBRTC &&
         contentType & rawRequestTypes & httpRequestTypes)) ||
      (contentType & typeMap.WEBRTC && contentType != typeMap.WEBRTC &&
       !(contentType & typeMap.WEBSOCKET &&
         contentType & rawRequestTypes & httpRequestTypes)))
  {
    if (contentType & typeMap.WEBSOCKET)
    {
      convertFilterAddRules(rules, filter, action, withResourceTypes,
                            exceptionDomains, typeMap.WEBSOCKET);
    }

    if (contentType & typeMap.WEBRTC)
    {
      convertFilterAddRules(rules, filter, action, withResourceTypes,
                            exceptionDomains, typeMap.WEBRTC);
    }

    contentType &= ~(typeMap.WEBSOCKET | typeMap.WEBRTC);

    if (!contentType)
      return;
  }

  let urlSchemes = getURLSchemes(contentType);
  let parsed = parseFilterRegexpSource(filter.regexpSource, urlSchemes[0]);

  // For the special case of $document whitelisting filters with just a domain
  // we can generate an equivalent blocking rule exception using if-domain.
  if (filter instanceof filterClasses.WhitelistFilter &&
      contentType & typeMap.DOCUMENT &&
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
    if (!(contentType & whitelistableRequestTypes))
      return;
  }

  let trigger = {"url-filter": parsed.regexp};

  // If the URL filter begins with one of the URL schemes for this content
  // type, we generate additional rules for all the URL scheme patterns;
  // otherwise, if the start of the URL filter literally matches the first URL
  // scheme pattern, we just generate additional rules for the remaining URL
  // scheme patterns.
  //
  // For example, "stun:foo$webrtc" will give us "stun:foo", then we add a "^"
  // in front of this and generate two additional rules for
  // "^stuns?:.*stun:foo" and "^turns?:.*stun:foo". On the other hand,
  // "||foo$webrtc" will give us "^stuns?:([^/]+\\.)?foo", so we just generate
  // "^turns?:([^/]+\\.)?foo" in addition.
  //
  // Note that the filter can be already anchored to the beginning
  // (e.g. "|stun:foo$webrtc"), in which case we do not generate any additional
  // rules.
  let needAltRules = trigger["url-filter"][0] != "^" ||
                     trigger["url-filter"].startsWith("^" + urlSchemes[0]);

  if (trigger["url-filter"][0] != "^")
  {
    if (!urlSchemes.some(scheme => new RegExp("^" + scheme)
                                   .test(trigger["url-filter"])))
    {
      trigger["url-filter"] = urlSchemes[0] + ".*" + trigger["url-filter"];
    }

    trigger["url-filter"] = "^" + trigger["url-filter"];
  }

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
    let resourceTypes = getResourceTypes(contentType);

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

  let addTopLevelException = false;

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
    addTopLevelException = true;
    excludeTopURLFromTrigger(trigger);
  }

  rules.push({trigger: trigger, action: {type: action}});

  if (needAltRules)
  {
    // Generate additional rules for any alternative URL schemes.
    for (let altRule of makeRuleCopies(trigger, {type: action}, urlSchemes))
    {
      if (addTopLevelException)
        excludeTopURLFromTrigger(altRule.trigger);

      rules.push(altRule);
    }
  }
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

function addCSSRules(rules, selectors, domain, exceptionDomains)
{
  let unlessDomain = exceptionDomains.size > 0 ? [] : null;

  exceptionDomains.forEach(name =>
  {
    // For domain-specific filters, include the exception domains only if
    // they're subdomains of the given domain.
    if (!domain || name.substr(-domain.length - 1) == "." + domain)
      unlessDomain.push("*" + name);
  });

  while (selectors.length)
  {
    let selector = selectors.splice(0, selectorLimit).join(", ");

    // As of Safari 9.0 element IDs are matched as lowercase. We work around
    // this by converting to the attribute format [id="elementID"]
    selector = convertIDSelectorsToAttributeSelectors(selector);

    let rule = {
      trigger: {"url-filter": matchDomain(domain),
                "url-filter-is-case-sensitive": true},
      action: {type: "css-display-none",
               selector: selector}
    };

    if (unlessDomain)
      rule.trigger["unless-domain"] = unlessDomain;

    rules.push(rule);
  }
}

/**
 * Check if two strings are a close match
 *
 * This function returns an edit operation, one of "substitute", "delete", and
 * "insert", along with an index in the source string where the edit must occur
 * in order to arrive at the target string. If the strings are not a close
 * match, it returns null.
 *
 * Two strings are considered to be a close match if they are one edit
 * operation apart.
 *
 * Deletions or insertions of a contiguous range of characters from one string
 * into the other, at the same index, are treated as a single edit. For
 * example, "internal" and "international" are considered to be one edit apart
 * and therefore a close match.
 *
 * A few things to note:
 *
 *   1) This function does not care about the format of the input strings. For
 *   example, the caller may pass in regular expressions, where "[ab]" and
 *   "[bc]" could be considered to be a close match, since the order within the
 *   brackets doesn't matter. This function will still return null for this set
 *   of inputs since they are two edits apart.
 *
 *   2) To be friendly to calling code that might be passing in regular
 *   expressions, this function will simply return null if it encounters a
 *   special character (e.g. "\", "?", "+", etc.) in the delta. For example,
 *   given "Hello" and "Hello, how are you?", it will return null.
 *
 *   3) If the caller does indeed pass in regular expressions, it must make the
 *   important assumption that the parts where two such regular expressions may
 *   differ can always be treated as normal strings. For example,
 *   "^https?://example.com/ads" and "^https?://example.com/adv" differ only in
 *   the last character, therefore the regular expressions can safely be merged
 *   into "^https?://example.com/ad[sv]".
 *
 * @param {string} s The source string
 * @param {string} t The target string
 *
 * @returns {object} An object describing the single edit operation that must
 *                   occur in the source string in order to arrive at the
 *                   target string
 */
function closeMatch(s, t)
{
  let diff = s.length - t.length;

  // If target is longer than source, swap them for the purpose of our
  // calculation.
  if (diff < 0)
  {
    let tmp = s;
    s = t;
    t = tmp;
  }

  let edit = null;

  let i = 0;
  let j = 0;

  // Start from the beginning and keep going until we hit a character that
  // doesn't match.
  for (; i < s.length; i++)
  {
    if (s[i] != t[i])
      break;
  }

  // Now do exactly the same from the end, but also stop if we reach the
  // position where we terminated the previous loop.
  for (; j < t.length; j++)
  {
    if (t.length - j == i || s[s.length - j - 1] != t[t.length - j - 1])
      break;
  }

  if (diff == 0)
  {
    // If the strings are equal in length and the delta isn't exactly one
    // character, it's not a close match.
    if (t.length - j - i != 1)
      return null;
  }
  else if (i != t.length - j)
  {
    // For strings of unequal length, if we haven't found a match for every
    // single character in the shorter string counting from both the beginning
    // and the end, it's not a close match.
    return null;
  }

  for (let k = i; k < s.length - j; k++)
  {
    // If the delta contains any special characters, it's not a close match.
    if (s[k] == "." || s[k] == "+" || s[k] == "$" || s[k] == "?" ||
        s[k] == "{" || s[k] == "}" || s[k] == "(" || s[k] == ")" ||
        s[k] == "[" || s[k] == "]" || s[k] == "\\")
      return null;
  }

  if (diff == 0)
  {
    edit = {type: "substitute", index: i};
  }
  else if (diff > 0)
  {
    edit = {type: "delete", index: i};

    if (diff > 1)
      edit.endIndex = s.length - j;
  }
  else
  {
    edit = {type: "insert", index: i};

    if (diff < -1)
      edit.endIndex = s.length - j;
  }

  return edit;
}

function eliminateRedundantRulesByURLFilter(rulesInfo, exhaustive)
{
  const heuristicRange = 1000;

  let ol = rulesInfo.length;

  // Throw out obviously redundant rules.
  return async(rulesInfo, (ruleInfo, index) => () =>
  {
    // If this rule is already marked as redundant, don't bother comparing it
    // with other rules.
    if (rulesInfo[index].redundant)
      return;

    let limit = exhaustive ? rulesInfo.length :
                Math.min(index + heuristicRange, rulesInfo.length);

    for (let i = index, j = i + 1; j < limit; j++)
    {
      if (rulesInfo[j].redundant)
        continue;

      let source = rulesInfo[i].rule.trigger["url-filter"];
      let target = rulesInfo[j].rule.trigger["url-filter"];

      if (source.length >= target.length)
      {
        // If one URL filter is a substring of the other starting at the
        // beginning, the other one is clearly redundant.
        if (source.substring(0, target.length) == target)
        {
          rulesInfo[i].redundant = true;
          break;
        }
      }
      else if (target.substring(0, source.length) == source)
      {
        rulesInfo[j].redundant = true;
      }
    }
  })
  .then(() => rulesInfo.filter(ruleInfo => !ruleInfo.redundant));
}

function findMatchesForRuleByURLFilter(rulesInfo, index, exhaustive)
{
  // Closely matching rules are likely to be within a certain range. We only
  // look for matches within this range by default. If we increase this value,
  // it can give us more matches and a smaller resulting rule set, but possibly
  // at a significant performance cost.
  //
  // If the exhaustive option is true, we simply ignore this value and look for
  // matches throughout the rule set.
  const heuristicRange = 1000;

  let limit = exhaustive ? rulesInfo.length :
              Math.min(index + heuristicRange, rulesInfo.length);

  for (let i = index, j = i + 1; j < limit; j++)
  {
    let source = rulesInfo[i].rule.trigger["url-filter"];
    let target = rulesInfo[j].rule.trigger["url-filter"];

    let edit = closeMatch(source, target);

    if (edit)
    {
      let urlFilter, ruleInfo, match = {edit};

      if (edit.type == "insert")
      {
        // Convert the insertion into a deletion and stick it on the target
        // rule instead. We can only group deletions and substitutions;
        // therefore insertions must be treated as deletions on the target
        // rule.
        urlFilter = target;
        ruleInfo = rulesInfo[j];
        match.index = i;
        edit.type = "delete";
      }
      else
      {
        urlFilter = source;
        ruleInfo = rulesInfo[i];
        match.index = j;
      }

      // If the edit has an end index, it represents a multiple character
      // edit.
      let multiEdit = !!edit.endIndex;

      if (multiEdit)
      {
        // We only care about a single multiple character edit because the
        // number of characters for such a match doesn't matter, we can
        // only merge with one other rule.
        if (!ruleInfo.multiEditMatch)
          ruleInfo.multiEditMatch = match;
      }
      else
      {
        // For single character edits, multiple rules can be merged into
        // one. e.g. "ad", "ads", and "adv" can be merged into "ad[sv]?".
        if (!ruleInfo.matches)
          ruleInfo.matches = new Array(urlFilter.length);

        // Matches at a particular index. For example, for a source string
        // "ads", both target strings "ad" (deletion) and "adv"
        // (substitution) match at index 2, hence they are grouped together
        // to possibly be merged later into "ad[sv]?".
        let matchesForIndex = ruleInfo.matches[edit.index];

        if (matchesForIndex)
        {
          matchesForIndex.push(match);
        }
        else
        {
          matchesForIndex = [match];
          ruleInfo.matches[edit.index] = matchesForIndex;
        }

        // Keep track of the best set of matches. We later sort by this to
        // get best results.
        if (!ruleInfo.bestMatches ||
            matchesForIndex.length > ruleInfo.bestMatches.length)
          ruleInfo.bestMatches = matchesForIndex;
      }
    }
  }
}

function mergeCandidateRulesByURLFilter(rulesInfo)
{
  // Filter out rules that have no matches at all.
  let candidateRulesInfo = rulesInfo.filter(ruleInfo =>
  {
    return ruleInfo.bestMatches || ruleInfo.multiEditMatch
  });

  // For best results, we have to sort the candidates by the largest set of
  // matches.
  //
  // For example, we want "ads", "bds", "adv", "bdv", "adx", and "bdx" to
  // generate "ad[svx]" and "bd[svx]" (2 rules), not "[ab]ds", "[ab]dv", and
  // "[ab]dx" (3 rules).
  candidateRulesInfo.sort((ruleInfo1, ruleInfo2) =>
  {
    let weight1 = ruleInfo1.bestMatches ? ruleInfo1.bestMatches.length :
                  ruleInfo1.multiEditMatch ? 1 : 0;
    let weight2 = ruleInfo2.bestMatches ? ruleInfo2.bestMatches.length :
                  ruleInfo2.multiEditMatch ? 1 : 0;

    return weight2 - weight1;
  });

  for (let ruleInfo of candidateRulesInfo)
  {
    let rule = ruleInfo.rule;

    // If this rule has already been merged into another rule, we skip it.
    if (ruleInfo.merged)
      continue;

    // Find the best set of rules to group, which is simply the largest set.
    let best = (ruleInfo.matches || []).reduce((best, matchesForIndex) =>
    {
      matchesForIndex = (matchesForIndex || []).filter(match =>
      {
        // Filter out rules that have either already been merged into other
        // rules or have had other rules merged into them.
        return !rulesInfo[match.index].merged &&
               !rulesInfo[match.index].mergedInto;
      });

      return matchesForIndex.length > best.length ? matchesForIndex : best;
    },
    []);

    let multiEdit = false;

    // If we couldn't find a single rule to merge with, let's see if we have a
    // multiple character edit. e.g. we could merge "ad" and "adserver" into
    // "ad(server)?".
    if (best.length == 0 && ruleInfo.multiEditMatch &&
        !rulesInfo[ruleInfo.multiEditMatch.index].merged &&
        !rulesInfo[ruleInfo.multiEditMatch.index].mergedInto)
    {
      best = [ruleInfo.multiEditMatch];
      multiEdit = true;
    }

    if (best.length > 0)
    {
      let urlFilter = rule.trigger["url-filter"];

      let editIndex = best[0].edit.index;

      if (!multiEdit)
      {
        // Merge all the matching rules into this one.

        let characters = [urlFilter[editIndex]];
        let quantifier = "";

        for (let match of best)
        {
          if (match.edit.type == "delete")
          {
            quantifier = "?";
          }
          else
          {
            let character = rulesInfo[match.index].rule
                            .trigger["url-filter"][editIndex];

            // Insert any hyphen at the beginning so it gets interpreted as a
            // literal hyphen.
            if (character == "-")
              characters.unshift(character);
            else
              characters.push(character);
          }

          // Mark the target rule as merged so other rules don't try to merge
          // it again.
          rulesInfo[match.index].merged = true;
        }

        urlFilter = urlFilter.substring(0, editIndex + 1) + quantifier +
                    urlFilter.substring(editIndex + 1);
        if (characters.length > 1)
        {
          urlFilter = urlFilter.substring(0, editIndex) + "[" +
                      characters.join("") + "]" +
                      urlFilter.substring(editIndex + 1);
        }
      }
      else
      {
        let editEndIndex = best[0].edit.endIndex;

        // Mark the target rule as merged so other rules don't try to merge it
        // again.
        rulesInfo[best[0].index].merged = true;

        urlFilter = urlFilter.substring(0, editIndex) + "(" +
                    urlFilter.substring(editIndex, editEndIndex) + ")?" +
                    urlFilter.substring(editEndIndex);
      }

      rule.trigger["url-filter"] = urlFilter;

      // Mark this rule as one that has had other rules merged into it.
      ruleInfo.mergedInto = true;
    }
  }
}

function mergeRulesByURLFilter(rulesInfo, exhaustive)
{
  return async(rulesInfo, (ruleInfo, index) => () =>
    findMatchesForRuleByURLFilter(rulesInfo, index, exhaustive)
  )
  .then(() => mergeCandidateRulesByURLFilter(rulesInfo));
}

function mergeRulesByArrayProperty(rulesInfo, propertyType, property)
{
  if (rulesInfo.length <= 1)
    return;

  let valueSet = new Set(rulesInfo[0].rule[propertyType][property]);

  for (let i = 1; i < rulesInfo.length; i++)
  {
    for (let value of rulesInfo[i].rule[propertyType][property] || [])
      valueSet.add(value);

    rulesInfo[i].merged = true;
  }

  if (valueSet.size > 0)
    rulesInfo[0].rule[propertyType][property] = Array.from(valueSet);

  rulesInfo[0].mergedInto = true;
}

function groupRulesByMergeableProperty(rulesInfo, propertyType, property)
{
  let mergeableRulesInfoByGroup = new Map();

  for (let ruleInfo of rulesInfo)
  {
    let copy = {
      trigger: Object.assign({}, ruleInfo.rule.trigger),
      action: Object.assign({}, ruleInfo.rule.action)
    };

    delete copy[propertyType][property];

    let groupKey = JSON.stringify(copy);

    let mergeableRulesInfo = mergeableRulesInfoByGroup.get(groupKey);

    if (mergeableRulesInfo)
      mergeableRulesInfo.push(ruleInfo);
    else
      mergeableRulesInfoByGroup.set(groupKey, [ruleInfo]);
  }

  return mergeableRulesInfoByGroup;
}

function mergeRules(rules, exhaustive)
{
  let rulesInfo = rules.map(rule => ({rule}));

  let arrayPropertiesToMergeBy = ["resource-type", "if-domain"];

  return async(() =>
  {
    let map = groupRulesByMergeableProperty(rulesInfo, "trigger", "url-filter");
    return async(map.values(), mergeableRulesInfo => () =>
      eliminateRedundantRulesByURLFilter(mergeableRulesInfo, exhaustive)
      .then(rulesInfo => mergeRulesByURLFilter(rulesInfo, exhaustive))
    )
    .then(() =>
    {
      // Filter out rules that are redundant or have been merged into other
      // rules.
      rulesInfo = rulesInfo.filter(ruleInfo => !ruleInfo.redundant &&
                                               !ruleInfo.merged);
    });
  })
  .then(() => async(arrayPropertiesToMergeBy, arrayProperty => () =>
  {
    let map = groupRulesByMergeableProperty(rulesInfo, "trigger",
                                            arrayProperty);
    return async(map.values(), mergeableRulesInfo => () =>
      mergeRulesByArrayProperty(mergeableRulesInfo, "trigger", arrayProperty)
    )
    .then(() =>
    {
      rulesInfo = rulesInfo.filter(ruleInfo => !ruleInfo.merged);
    });
  }))
  .then(() => rulesInfo.map(ruleInfo => ruleInfo.rule));
}

let ContentBlockerList =
/**
 * Create a new Adblock Plus filter to content blocker list converter
 *
 * @param {object} options Options for content blocker list generation
 *
 * @constructor
 */
exports.ContentBlockerList = function (options)
{
  const defaultOptions = {
    merge: "auto"
  };

  this.options = Object.assign({}, defaultOptions, options);

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
 */
ContentBlockerList.prototype.generateRules = function()
{
  let cssRules = [];
  let cssExceptionRules = [];
  let blockingRules = [];
  let blockingExceptionRules = [];

  let ruleGroups = [cssRules, cssExceptionRules,
                    blockingRules, blockingExceptionRules];

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

  addCSSRules(cssRules, genericSelectors, null,
              genericSelectorExceptionDomains);

  // Filter out whitelisted domains.
  elemhideExceptionDomains.forEach(domain =>
    groupedElemhideFilters.delete(domain));

  groupedElemhideFilters.forEach((selectors, matchDomain) =>
  {
    addCSSRules(cssRules, selectors, matchDomain, elemhideExceptionDomains);
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
    convertFilterAddRules(blockingRules, filter, "block", true,
                          requestFilterExceptionDomains);
  }

  for (let filter of this.requestExceptions)
  {
    convertFilterAddRules(blockingExceptionRules, filter,
                          "ignore-previous-rules", true);
  }

  return async(ruleGroups, (group, index) => () =>
  {
    let next = () =>
    {
      if (index == ruleGroups.length - 1)
        return ruleGroups.reduce((all, rules) => all.concat(rules), []);
    };

    if (this.options.merge == "all" ||
        (this.options.merge == "auto" &&
         ruleGroups.reduce((n, group) => n + group.length, 0) > 50000))
    {
      return mergeRules(ruleGroups[index], this.options.merge == "all")
      .then(rules =>
      {
        ruleGroups[index] = rules;
        return next();
      });
    }

    return next();
  });
};
