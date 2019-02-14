/*
 * This file is part of Adblock Plus <https://adblockplus.org/>,
 * Copyright (C) 2006-present eyeo GmbH
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

"use strict";

/**
 * @fileOverview Definition of Filter class and its subclasses.
 */

const {extend} = require("./coreUtils");
const {filterToRegExp} = require("./common");
const {suffixes} = require("./domain");

const resources = require("../data/resources.json");

/**
 * Map of internal resources for URL rewriting.
 * @type {Map.<string,string>}
 */
let resourceMap = new Map(
  Object.keys(resources).map(key => [key, resources[key]])
);

/**
 * Regular expression used to match the <code>||</code> prefix in an otherwise
 * literal pattern.
 * @type {RegExp}
 */
let doubleAnchorRegExp = new RegExp(filterToRegExp("||") + "$");

/**
 * Regular expression used to match the <code>^</code> suffix in an otherwise
 * literal pattern.
 * @type {RegExp}
 */
// Note: This should match the pattern in lib/common.js
let separatorRegExp = /[\x00-\x24\x26-\x2C\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\x7F]/;

/**
 * All known unique domain sources mapped to their parsed values.
 * @type {Map.<string,Map.<string,boolean>>}
 */
let knownDomainMaps = new Map();

/**
 * Checks whether the given pattern is a string of literal characters with no
 * wildcards or any other special characters. If the pattern is prefixed with a
 * <code>||</code> or suffixed with a <code>^</code> but otherwise contains no
 * special characters, it is still considered to be a literal pattern.
 * @param {string} pattern
 * @returns {boolean}
 */
function isLiteralPattern(pattern)
{
  return !/[*^|]/.test(pattern.replace(/^\|{2}/, "").replace(/\^$/, ""));
}

/**
 * Abstract base class for filters
 *
 * @param {string} text   string representation of the filter
 * @constructor
 */
function Filter(text)
{
  this.text = text;

  /**
   * Subscriptions to which this filter belongs.
   * @type {(Subscription|Set.<Subscription>)?}
   * @private
   */
  this._subscriptions = null;
}
exports.Filter = Filter;

Filter.prototype =
{
  /**
   * String representation of the filter
   * @type {string}
   */
  text: null,

  /**
   * Filter type as a string, e.g. "blocking".
   * @type {string}
   */
  get type()
  {
    throw new Error("Please define filter type in the subclass");
  },

  /**
   * Yields subscriptions to which the filter belongs.
   * @yields {Subscription}
   */
  *subscriptions()
  {
    if (this._subscriptions)
    {
      if (this._subscriptions instanceof Set)
        yield* this._subscriptions;
      else
        yield this._subscriptions;
    }
  },

  /**
   * The number of subscriptions to which the filter belongs.
   * @type {number}
   */
  get subscriptionCount()
  {
    if (this._subscriptions instanceof Set)
      return this._subscriptions.size;

    return this._subscriptions ? 1 : 0;
  },

  /**
   * Adds a subscription to the set of subscriptions to which the filter
   * belongs.
   * @param {Subscription} subscription
   */
  addSubscription(subscription)
  {
    // Since we use truthy checks in our logic, we must avoid adding a
    // subscription that isn't a non-null object.
    if (subscription === null || typeof subscription != "object")
      return;

    if (this._subscriptions)
    {
      if (this._subscriptions instanceof Set)
        this._subscriptions.add(subscription);
      else if (subscription != this._subscriptions)
        this._subscriptions = new Set([this._subscriptions, subscription]);
    }
    else
    {
      this._subscriptions = subscription;
    }
  },

  /**
   * Removes a subscription from the set of subscriptions to which the filter
   * belongs.
   * @param {Subscription} subscription
   */
  removeSubscription(subscription)
  {
    if (this._subscriptions)
    {
      if (this._subscriptions instanceof Set)
      {
        this._subscriptions.delete(subscription);

        if (this._subscriptions.size == 1)
          this._subscriptions = [...this._subscriptions][0];
      }
      else if (subscription == this._subscriptions)
      {
        this._subscriptions = null;
      }
    }
  },

  /**
   * Serializes the filter for writing out on disk.
   * @yields {string}
   */
  *serialize()
  {
    let {text} = this;

    yield "[Filter]";
    yield "text=" + text;
  },

  toString()
  {
    return this.text;
  }
};

/**
 * Cache for known filters, maps string representation to filter objects.
 * @type {Map.<string,Filter>}
 */
Filter.knownFilters = new Map();

/**
 * Regular expression that content filters should match
 * @type {RegExp}
 */
Filter.contentRegExp = /^([^/*|@"!]*?)#([@?$])?#(.+)$/;
/**
 * Regular expression that options on a RegExp filter should match
 * @type {RegExp}
 */
Filter.optionsRegExp = /\$(~?[\w-]+(?:=[^,]*)?(?:,~?[\w-]+(?:=[^,]*)?)*)$/;
/**
 * Regular expression that matches an invalid Content Security Policy
 * @type {RegExp}
 */
Filter.invalidCSPRegExp = /(;|^) ?(base-uri|referrer|report-to|report-uri|upgrade-insecure-requests)\b/i;

/**
 * Creates a filter of correct type from its text representation - does the
 * basic parsing and calls the right constructor then.
 *
 * @param {string} text   as in Filter()
 * @return {Filter}
 */
Filter.fromText = function(text)
{
  let filter = Filter.knownFilters.get(text);
  if (filter)
    return filter;

  if (text[0] == "!")
  {
    filter = new CommentFilter(text);
  }
  else
  {
    let match = text.includes("#") ? Filter.contentRegExp.exec(text) : null;
    if (match)
      filter = ContentFilter.fromText(text, match[1], match[2], match[3]);
    else
      filter = RegExpFilter.fromText(text);
  }

  Filter.knownFilters.set(filter.text, filter);
  return filter;
};

/**
 * Deserializes a filter
 *
 * @param {Object}  obj map of serialized properties and their values
 * @return {Filter} filter or null if the filter couldn't be created
 */
Filter.fromObject = function(obj)
{
  let filter = Filter.fromText(obj.text);
  if (filter instanceof ActiveFilter)
  {
    if ("disabled" in obj)
      filter._disabled = (obj.disabled == "true");
    if ("hitCount" in obj)
      filter._hitCount = parseInt(obj.hitCount, 10) || 0;
    if ("lastHit" in obj)
      filter._lastHit = parseInt(obj.lastHit, 10) || 0;
  }
  return filter;
};

/**
 * Removes unnecessary whitespaces from filter text, will only return null if
 * the input parameter is null.
 * @param {string} text
 * @return {string}
 */
Filter.normalize = function(text)
{
  if (!text)
    return text;

  // Remove line breaks, tabs etc
  text = text.replace(/[^\S ]+/g, "");

  // Don't remove spaces inside comments
  if (/^ *!/.test(text))
    return text.trim();

  // Special treatment for content filters, right side is allowed to contain
  // spaces
  if (Filter.contentRegExp.test(text))
  {
    let [, domains, separator, body] = /^(.*?)(#[@?$]?#?)(.*)$/.exec(text);
    return domains.replace(/ +/g, "") + separator + body.trim();
  }

  // For most regexp filters we strip all spaces, but $csp filter options
  // are allowed to contain single (non trailing) spaces.
  let strippedText = text.replace(/ +/g, "");
  if (!strippedText.includes("$") || !/\bcsp=/i.test(strippedText))
    return strippedText;

  let optionsMatch = Filter.optionsRegExp.exec(strippedText);
  if (!optionsMatch)
    return strippedText;

  // For $csp filters we must first separate out the options part of the
  // text, being careful to preserve its spaces.
  let beforeOptions = strippedText.substring(0, optionsMatch.index);
  let strippedDollarIndex = -1;
  let dollarIndex = -1;
  do
  {
    strippedDollarIndex = beforeOptions.indexOf("$", strippedDollarIndex + 1);
    dollarIndex = text.indexOf("$", dollarIndex + 1);
  }
  while (strippedDollarIndex != -1);
  let optionsText = text.substr(dollarIndex + 1);

  // Then we can normalize spaces in the options part safely
  let options = optionsText.split(",");
  for (let i = 0; i < options.length; i++)
  {
    let option = options[i];
    let cspMatch = /^ *c *s *p *=/i.exec(option);
    if (cspMatch)
    {
      options[i] = cspMatch[0].replace(/ +/g, "") +
                   option.substr(cspMatch[0].length).trim().replace(/ +/g, " ");
    }
    else
      options[i] = option.replace(/ +/g, "");
  }

  return beforeOptions + "$" + options.join();
};

/**
 * Class for invalid filters
 * @param {string} text see {@link Filter Filter()}
 * @param {string} reason Reason why this filter is invalid
 * @constructor
 * @augments Filter
 */
function InvalidFilter(text, reason)
{
  Filter.call(this, text);

  this.reason = reason;
}
exports.InvalidFilter = InvalidFilter;

InvalidFilter.prototype = extend(Filter, {
  type: "invalid",

  /**
   * Reason why this filter is invalid
   * @type {string}
   */
  reason: null,

  /**
   * See Filter.serialize()
   * @inheritdoc
   */
  *serialize() {}
});

/**
 * Class for comments
 * @param {string} text see {@link Filter Filter()}
 * @constructor
 * @augments Filter
 */
function CommentFilter(text)
{
  Filter.call(this, text);
}
exports.CommentFilter = CommentFilter;

CommentFilter.prototype = extend(Filter, {
  type: "comment",

  /**
   * See Filter.serialize()
   * @inheritdoc
   */
  *serialize() {}
});

/**
 * Abstract base class for filters that can get hits
 * @param {string} text
 *   see {@link Filter Filter()}
 * @param {string} [domains]
 *   Domains that the filter is restricted to separated by domainSeparator
 *   e.g. "foo.com|bar.com|~baz.com"
 * @constructor
 * @augments Filter
 */
function ActiveFilter(text, domains)
{
  Filter.call(this, text);

  if (domains)
    this.domainSource = domains;
}
exports.ActiveFilter = ActiveFilter;

ActiveFilter.prototype = extend(Filter, {
  _disabled: false,
  _hitCount: 0,
  _lastHit: 0,

  /**
   * Defines whether the filter is disabled
   * @type {boolean}
   */
  get disabled()
  {
    return this._disabled;
  },
  set disabled(value)
  {
    if (value != this._disabled)
    {
      let oldValue = this._disabled;
      this._disabled = value;
    }
    return this._disabled;
  },

  /**
   * Number of hits on the filter since the last reset
   * @type {number}
   */
  get hitCount()
  {
    return this._hitCount;
  },
  set hitCount(value)
  {
    if (value != this._hitCount)
    {
      let oldValue = this._hitCount;
      this._hitCount = value;
    }
    return this._hitCount;
  },

  /**
   * Last time the filter had a hit (in milliseconds since the beginning of the
   * epoch)
   * @type {number}
   */
  get lastHit()
  {
    return this._lastHit;
  },
  set lastHit(value)
  {
    if (value != this._lastHit)
    {
      let oldValue = this._lastHit;
      this._lastHit = value;
    }
    return this._lastHit;
  },

  /**
   * String that the domains property should be generated from
   * @type {?string}
   */
  domainSource: null,

  /**
   * Separator character used in domainSource property, must be
   * overridden by subclasses
   * @type {string}
   */
  domainSeparator: null,

  /**
   * Map containing domains that this filter should match on/not match
   * on or null if the filter should match on all domains
   * @type {?Map.<string,boolean>}
   */
  get domains()
  {
    let domains = null;

    if (this.domainSource)
    {
      // For most filter types this property is accessed only rarely,
      // especially when the subscriptions are initially loaded. We defer any
      // caching by default.
      let cacheDomains = this._cacheDomains;

      let source = this.domainSource.toLowerCase();

      let knownMap = knownDomainMaps.get(source);
      if (knownMap)
      {
        domains = knownMap;
      }
      else
      {
        let list = source.split(this.domainSeparator);
        if (list.length == 1 && list[0][0] != "~")
        {
          // Fast track for the common one-domain scenario
          domains = new Map([[list[0], true], ["", false]]);
        }
        else
        {
          let hasIncludes = false;
          for (let i = 0; i < list.length; i++)
          {
            let domain = list[i];
            if (domain == "")
              continue;

            let include;
            if (domain[0] == "~")
            {
              include = false;
              domain = domain.substr(1);
            }
            else
            {
              include = true;
              hasIncludes = true;
            }

            if (!domains)
              domains = new Map();

            domains.set(domain, include);
          }

          if (domains)
            domains.set("", !hasIncludes);
        }

        if (!domains || cacheDomains)
          knownDomainMaps.set(source, domains);
      }

      if (!domains || cacheDomains)
      {
        this.domainSource = null;
        Object.defineProperty(this, "domains", {value: domains});
      }
    }

    this._cacheDomains = true;

    return domains;
  },

  /**
   * Whether the value of {@link ActiveFilter#domains} should be cached.
   * @type {boolean}
   * @private
   */
  _cacheDomains: false,

  /**
   * Array containing public keys of websites that this filter should apply to
   * @type {?string[]}
   */
  sitekeys: null,

  /**
   * Checks whether this filter is active on a domain.
   * @param {string} [docDomain] domain name of the document that loads the URL
   * @param {string} [sitekey] public key provided by the document
   * @return {boolean} true in case of the filter being active
   */
  isActiveOnDomain(docDomain, sitekey)
  {
    // Sitekeys are case-sensitive so we shouldn't convert them to
    // upper-case to avoid false positives here. Instead we need to
    // change the way filter options are parsed.
    if (this.sitekeys &&
        (!sitekey || !this.sitekeys.includes(sitekey.toUpperCase())))
    {
      return false;
    }

    let {domains} = this;

    // If no domains are set the rule matches everywhere
    if (!domains)
      return true;

    // If the document has no host name, match only if the filter
    // isn't restricted to specific domains
    if (!docDomain)
      return domains.get("");

    if (docDomain[docDomain.length - 1] == ".")
      docDomain = docDomain.replace(/\.+$/, "");

    docDomain = docDomain.toLowerCase();

    for (docDomain of suffixes(docDomain))
    {
      let isDomainIncluded = domains.get(docDomain);
      if (typeof isDomainIncluded != "undefined")
        return isDomainIncluded;
    }

    return domains.get("");
  },

  /**
   * Checks whether this filter is active only on a domain and its subdomains.
   * @param {string} docDomain
   * @return {boolean}
   */
  isActiveOnlyOnDomain(docDomain)
  {
    let {domains} = this;

    if (!docDomain || !domains || domains.get(""))
      return false;

    if (docDomain[docDomain.length - 1] == ".")
      docDomain = docDomain.replace(/\.+$/, "");

    docDomain = docDomain.toLowerCase();

    for (let [domain, isIncluded] of domains)
    {
      if (isIncluded && domain != docDomain)
      {
        if (domain.length <= docDomain.length)
          return false;

        if (!domain.endsWith("." + docDomain))
          return false;
      }
    }

    return true;
  },

  /**
   * Checks whether this filter is generic or specific
   * @return {boolean}
   */
  isGeneric()
  {
    let {sitekeys, domains} = this;

    return !(sitekeys && sitekeys.length) && (!domains || domains.get(""));
  },

  /**
   * See Filter.serialize()
   * @inheritdoc
   */
  *serialize()
  {
    let {_disabled, _hitCount, _lastHit} = this;

    if (_disabled || _hitCount || _lastHit)
    {
      yield* Filter.prototype.serialize.call(this);
      if (_disabled)
        yield "disabled=true";
      if (_hitCount)
        yield "hitCount=" + _hitCount;
      if (_lastHit)
        yield "lastHit=" + _lastHit;
    }
  }
});

/**
 * Abstract base class for RegExp-based filters
 * @param {string} text see {@link Filter Filter()}
 * @param {string} regexpSource
 *   filter part that the regular expression should be build from
 * @param {number} [contentType]
 *   Content types the filter applies to, combination of values from
 *   RegExpFilter.typeMap
 * @param {boolean} [matchCase]
 *   Defines whether the filter should distinguish between lower and upper case
 *   letters
 * @param {string} [domains]
 *   Domains that the filter is restricted to, e.g. "foo.com|bar.com|~baz.com"
 * @param {boolean} [thirdParty]
 *   Defines whether the filter should apply to third-party or first-party
 *   content only
 * @param {string} [sitekeys]
 *   Public keys of websites that this filter should apply to
 * @param {?string} [rewrite]
 *   The (optional) rule specifying how to rewrite the URL. See
 *   RegExpFilter.prototype.rewrite.
 * @param {?string} [resourceName]
 *   The name of the internal resource to which to rewrite the
 *   URL. e.g. if the value of the <code>rewrite</code> parameter is
 *   <code>abp-resource:blank-html</code>, this should be
 *   <code>blank-html</code>.
 * @constructor
 * @augments ActiveFilter
 */
function RegExpFilter(text, regexpSource, contentType, matchCase, domains,
                      thirdParty, sitekeys, rewrite, resourceName)
{
  ActiveFilter.call(this, text, domains);

  if (contentType != null)
    this.contentType = contentType;
  if (matchCase)
    this.matchCase = matchCase;
  if (thirdParty != null)
    this.thirdParty = thirdParty;
  if (sitekeys != null)
    this.sitekeySource = sitekeys;
  if (rewrite != null)
    this.rewrite = rewrite;
  if (resourceName)
    this.resourceName = resourceName;

  if (regexpSource.length >= 2 &&
      regexpSource[0] == "/" &&
      regexpSource[regexpSource.length - 1] == "/")
  {
    // The filter is a regular expression - convert it immediately to
    // catch syntax errors
    let regexp = new RegExp(regexpSource.substr(1, regexpSource.length - 2),
                            this.matchCase ? "" : "i");
    Object.defineProperty(this, "regexp", {value: regexp});
  }
  else
  {
    // Patterns like /foo/bar/* exist so that they are not treated as regular
    // expressions. We drop any superfluous wildcards here so our optimizations
    // can kick in.
    if (this.rewrite == null || this.resourceName)
      regexpSource = regexpSource.replace(/^\*+/, "").replace(/\*+$/, "");

    if (!this.matchCase && isLiteralPattern(regexpSource))
      regexpSource = regexpSource.toLowerCase();

    // No need to convert this filter to regular expression yet, do it on demand
    this.pattern = regexpSource;
  }
}
exports.RegExpFilter = RegExpFilter;

RegExpFilter.prototype = extend(ActiveFilter, {
  /**
   * Number of filters contained, will always be 1 (required to
   * optimize {@link Matcher}).
   * @type {number}
   * @package
   */
  size: 1,

  /**
   * @see ActiveFilter.domainSeparator
   */
  domainSeparator: "|",

  /**
   * Expression from which a regular expression should be generated -
   * for delayed creation of the regexp property
   * @type {?string}
   */
  pattern: null,
  /**
   * Regular expression to be used when testing against this filter
   * @type {RegExp}
   */
  get regexp()
  {
    let value = null;

    let {pattern, rewrite, resourceName} = this;
    if ((rewrite != null && !resourceName) || !isLiteralPattern(pattern))
    {
      value = new RegExp(filterToRegExp(pattern, rewrite != null),
                         this.matchCase ? "" : "i");
    }

    Object.defineProperty(this, "regexp", {value});
    return value;
  },
  /**
   * Content types the filter applies to, combination of values from
   * RegExpFilter.typeMap
   * @type {number}
   */
  contentType: 0x7FFFFFFF,
  /**
   * Defines whether the filter should distinguish between lower and
   * upper case letters
   * @type {boolean}
   */
  matchCase: false,
  /**
   * Defines whether the filter should apply to third-party or
   * first-party content only. Can be null (apply to all content).
   * @type {?boolean}
   */
  thirdParty: null,

  /**
   * String that the sitekey property should be generated from
   * @type {?string}
   */
  sitekeySource: null,

  /**
   * @see ActiveFilter.sitekeys
   */
  get sitekeys()
  {
    let sitekeys = null;

    if (this.sitekeySource)
    {
      sitekeys = this.sitekeySource.split("|");
      this.sitekeySource = null;
    }

    Object.defineProperty(
      this, "sitekeys", {value: sitekeys, enumerable: true}
    );
    return this.sitekeys;
  },

  /**
   * The rule specifying how to rewrite the URL.
   * The syntax is similar to the one of String.prototype.replace().
   * @type {?string}
   */
  rewrite: null,

  /**
   * The name of the internal resource to which to rewrite the
   * URL. e.g. if the value of the <code>rewrite</code> property is
   * <code>abp-resource:blank-html</code>, this should be
   * <code>blank-html</code>.
   * @type {?string}
   */
  resourceName: null,

  /**
   * Tests whether the URL matches this filter
   * @param {string} location URL to be tested
   * @param {number} typeMask bitmask of content / request types to match
   * @param {string} [docDomain] domain name of the document that loads the URL
   * @param {boolean} [thirdParty] should be true if the URL is a third-party
   *                               request
   * @param {string} [sitekey] public key provided by the document
   * @return {boolean} true in case of a match
   */
  matches(location, typeMask, docDomain, thirdParty, sitekey)
  {
    return (this.contentType & typeMask) != 0 &&
           (this.thirdParty == null || this.thirdParty == thirdParty) &&
           (this.regexp ? (this.isActiveOnDomain(docDomain, sitekey) &&
                           this.matchesLocation(location)) :
             (this.matchesLocation(location) &&
              this.isActiveOnDomain(docDomain, sitekey)));
  },

  /**
   * Checks whether the given URL matches this filter without checking the
   * filter's domains.
   * @param {string} location
   * @param {number} typeMask
   * @param {boolean} [thirdParty]
   * @param {string} [sitekey]
   * @return {boolean}
   * @package
   */
  matchesWithoutDomain(location, typeMask, thirdParty, sitekey)
  {
    return (this.contentType & typeMask) != 0 &&
           (this.thirdParty == null || this.thirdParty == thirdParty) &&
           this.matchesLocation(location) &&
           (!this.sitekeys ||
            (sitekey && this.sitekeys.includes(sitekey.toUpperCase())));
  },

  /**
   * Checks whether the given URL matches this filter's pattern.
   * @param {string} location The URL to check.
   * @param {?string} [lowerCaseLocation] The lower-case version of the URL to
   *   check, for case-insensitive matching.
   * @returns {boolean} <code>true</code> if the URL matches.
   * @package
   */
  matchesLocation(location, lowerCaseLocation)
  {
    let {regexp} = this;

    if (regexp)
      return regexp.test(location);

    if (!this.matchCase)
      location = lowerCaseLocation || location.toLowerCase();

    let {pattern} = this;

    let startsWithDoubleAnchor = pattern[0] == "|" && pattern[1] == "|";
    let endsWithSeparator = pattern[pattern.length - 1] == "^";

    if (startsWithDoubleAnchor)
      pattern = pattern.substr(2);

    if (endsWithSeparator)
      pattern = pattern.slice(0, -1);

    let index = location.indexOf(pattern);

    // The "||" prefix requires that the text that follows does not start
    // with a forward slash.
    return index != -1 &&
           (!startsWithDoubleAnchor || location[index] != "/" &&
            doubleAnchorRegExp.test(location.substring(0, index))) &&
           (!endsWithSeparator || !location[index + pattern.length] ||
            separatorRegExp.test(location[index + pattern.length]));
  },

  /**
   * Checks whether this filter has only a URL pattern and no content type,
   * third-party flag, domains, or sitekeys.
   * @returns {boolean}
   */
  isLocationOnly()
  {
    return this.contentType == RegExpFilter.prototype.contentType &&
           this.thirdParty == null &&
           !this.domainSource && !this.sitekeySource &&
           !this.domains && !this.sitekeys;
  }
});

/**
 * Yields the filter itself (required to optimize {@link Matcher}).
 * @yields {RegExpFilter}
 * @package
 */
RegExpFilter.prototype[Symbol.iterator] = function*()
{
  yield this;
};

/**
 * Yields a key-value pair consisting of the filter itself and the value
 * <code>true</code> (required to optimize {@link Matcher}).
 * @yields {Array}
 * @package
 */
RegExpFilter.prototype.entries = function*()
{
  yield [this, true];
};

/**
 * Creates a RegExp filter from its text representation
 * @param {string} text   same as in Filter()
 * @return {Filter}
 */
RegExpFilter.fromText = function(text)
{
  let blocking = true;
  let origText = text;
  if (text[0] == "@" && text[1] == "@")
  {
    blocking = false;
    text = text.substr(2);
  }

  let contentType = null;
  let matchCase = null;
  let domains = null;
  let sitekeys = null;
  let thirdParty = null;
  let collapse = null;
  let csp = null;
  let rewrite = null;
  let resourceName = null;
  let options;
  let match = text.includes("$") ? Filter.optionsRegExp.exec(text) : null;
  if (match)
  {
    options = match[1].split(",");
    text = match.input.substr(0, match.index);
    for (let option of options)
    {
      let value = null;
      let separatorIndex = option.indexOf("=");
      if (separatorIndex >= 0)
      {
        value = option.substr(separatorIndex + 1);
        option = option.substr(0, separatorIndex);
      }

      let inverse = option[0] == "~";
      if (inverse)
        option = option.substr(1);

      let type = RegExpFilter.typeMap[option.replace(/-/, "_").toUpperCase()];
      if (type)
      {
        if (inverse)
        {
          if (contentType == null)
            ({contentType} = RegExpFilter.prototype);
          contentType &= ~type;
        }
        else
        {
          contentType |= type;

          if (type == RegExpFilter.typeMap.CSP)
          {
            if (blocking && !value)
              return new InvalidFilter(origText, "filter_invalid_csp");
            csp = value;
          }
        }
      }
      else
      {
        switch (option.toLowerCase())
        {
          case "match-case":
            matchCase = !inverse;
            break;
          case "domain":
            if (!value)
              return new InvalidFilter(origText, "filter_unknown_option");
            domains = value;
            break;
          case "third-party":
            thirdParty = !inverse;
            break;
          case "collapse":
            collapse = !inverse;
            break;
          case "sitekey":
            if (!value)
              return new InvalidFilter(origText, "filter_unknown_option");
            sitekeys = value.toUpperCase();
            break;
          case "rewrite":
            if (value == null)
              return new InvalidFilter(origText, "filter_unknown_option");
            rewrite = value;
            if (value.startsWith("abp-resource:"))
              resourceName = value.substr("abp-resource:".length);
            break;
          default:
            return new InvalidFilter(origText, "filter_unknown_option");
        }
      }
    }
  }

  // For security reasons, never match $rewrite filters
  // against requests that might load any code to be executed.
  // Unless it is to an internal resource.
  if (rewrite != null && !resourceName)
  {
    if (contentType == null)
      ({contentType} = RegExpFilter.prototype);
    contentType &= ~(RegExpFilter.typeMap.SCRIPT |
                     RegExpFilter.typeMap.SUBDOCUMENT |
                     RegExpFilter.typeMap.OBJECT |
                     RegExpFilter.typeMap.OBJECT_SUBREQUEST);
  }

  try
  {
    if (blocking)
    {
      if (csp && Filter.invalidCSPRegExp.test(csp))
        return new InvalidFilter(origText, "filter_invalid_csp");

      if (resourceName)
      {
        if (text[0] == "|" && text[1] == "|")
        {
          if (!domains && thirdParty != false)
            return new InvalidFilter(origText, "filter_invalid_rewrite");
        }
        else if (text[0] == "*")
        {
          if (!domains)
            return new InvalidFilter(origText, "filter_invalid_rewrite");
        }
        else
        {
          return new InvalidFilter(origText, "filter_invalid_rewrite");
        }
      }

      return new BlockingFilter(origText, text, contentType, matchCase, domains,
                                thirdParty, sitekeys, rewrite, resourceName,
                                collapse, csp);
    }
    return new WhitelistFilter(origText, text, contentType, matchCase, domains,
                               thirdParty, sitekeys);
  }
  catch (e)
  {
    return new InvalidFilter(origText, "filter_invalid_regexp");
  }
};

/**
 * Maps type strings like "SCRIPT" or "OBJECT" to bit masks
 */
RegExpFilter.typeMap = {
  OTHER: 1,
  SCRIPT: 2,
  IMAGE: 4,
  STYLESHEET: 8,
  OBJECT: 16,
  SUBDOCUMENT: 32,
  DOCUMENT: 64,
  WEBSOCKET: 128,
  WEBRTC: 256,
  CSP: 512,
  XBL: 1,
  PING: 1024,
  XMLHTTPREQUEST: 2048,
  OBJECT_SUBREQUEST: 4096,
  DTD: 1,
  MEDIA: 16384,
  FONT: 32768,

  BACKGROUND: 4,    // Backwards compat, same as IMAGE

  POPUP: 0x10000000,
  GENERICBLOCK: 0x20000000,
  ELEMHIDE: 0x40000000,
  GENERICHIDE: 0x80000000
};

// CSP, DOCUMENT, ELEMHIDE, POPUP, GENERICHIDE and GENERICBLOCK options
// shouldn't be there by default
RegExpFilter.prototype.contentType &= ~(RegExpFilter.typeMap.CSP |
                                        RegExpFilter.typeMap.DOCUMENT |
                                        RegExpFilter.typeMap.ELEMHIDE |
                                        RegExpFilter.typeMap.POPUP |
                                        RegExpFilter.typeMap.GENERICHIDE |
                                        RegExpFilter.typeMap.GENERICBLOCK);

/**
 * Class for blocking filters
 * @param {string} text see {@link Filter Filter()}
 * @param {string} regexpSource see {@link RegExpFilter RegExpFilter()}
 * @param {number} [contentType] see {@link RegExpFilter RegExpFilter()}
 * @param {boolean} [matchCase] see {@link RegExpFilter RegExpFilter()}
 * @param {string} [domains] see {@link RegExpFilter RegExpFilter()}
 * @param {boolean} [thirdParty] see {@link RegExpFilter RegExpFilter()}
 * @param {string} [sitekeys] see {@link RegExpFilter RegExpFilter()}
 * @param {?string} [rewrite]
 *   The (optional) rule specifying how to rewrite the URL. See
 *   RegExpFilter.prototype.rewrite.
 * @param {?string} [resourceName]
 *   The name of the internal resource to which to rewrite the
 *   URL. e.g. if the value of the <code>rewrite</code> parameter is
 *   <code>abp-resource:blank-html</code>, this should be
 *   <code>blank-html</code>.
 * @param {boolean} [collapse]
 *   defines whether the filter should collapse blocked content, can be null
 * @param {string} [csp]
 *   Content Security Policy to inject when the filter matches
 * @constructor
 * @augments RegExpFilter
 */
function BlockingFilter(text, regexpSource, contentType, matchCase, domains,
                        thirdParty, sitekeys, rewrite, resourceName,
                        collapse, csp)
{
  RegExpFilter.call(this, text, regexpSource, contentType, matchCase, domains,
                    thirdParty, sitekeys, rewrite, resourceName);

  if (collapse != null)
    this.collapse = collapse;

  if (csp != null)
    this.csp = csp;
}
exports.BlockingFilter = BlockingFilter;

BlockingFilter.prototype = extend(RegExpFilter, {
  type: "blocking",

  /**
   * Defines whether the filter should collapse blocked content.
   * Can be null (use the global preference).
   * @type {?boolean}
   */
  collapse: null,

  /**
   * Content Security Policy to inject for matching requests.
   * @type {?string}
   */
  csp: null,

  /**
   * Rewrites an URL.
   * @param {string} url the URL to rewrite
   * @return {string} the rewritten URL, or the original in case of failure
   */
  rewriteUrl(url)
  {
    if (this.resourceName)
      return resourceMap.get(this.resourceName) || url;

    try
    {
      let rewrittenUrl = new URL(url.replace(this.regexp, this.rewrite), url);
      if (rewrittenUrl.origin == new URL(url).origin)
        return rewrittenUrl.href;
    }
    catch (e)
    {
    }

    return url;
  }
});

/**
 * Class for whitelist filters
 * @param {string} text see {@link Filter Filter()}
 * @param {string} regexpSource see {@link RegExpFilter RegExpFilter()}
 * @param {number} [contentType] see {@link RegExpFilter RegExpFilter()}
 * @param {boolean} [matchCase] see {@link RegExpFilter RegExpFilter()}
 * @param {string} [domains] see {@link RegExpFilter RegExpFilter()}
 * @param {boolean} [thirdParty] see {@link RegExpFilter RegExpFilter()}
 * @param {string} [sitekeys] see {@link RegExpFilter RegExpFilter()}
 * @constructor
 * @augments RegExpFilter
 */
function WhitelistFilter(text, regexpSource, contentType, matchCase, domains,
                         thirdParty, sitekeys)
{
  RegExpFilter.call(this, text, regexpSource, contentType, matchCase, domains,
                    thirdParty, sitekeys);
}
exports.WhitelistFilter = WhitelistFilter;

WhitelistFilter.prototype = extend(RegExpFilter, {
  type: "whitelist"
});

/**
 * Base class for content filters
 * @param {string} text see {@link Filter Filter()}
 * @param {string} [domains] Host names or domains the filter should be
 *                           restricted to
 * @param {string} body      The body of the filter
 * @constructor
 * @augments ActiveFilter
 */
function ContentFilter(text, domains, body)
{
  ActiveFilter.call(this, text, domains || null);

  this.body = body;
}
exports.ContentFilter = ContentFilter;

ContentFilter.prototype = extend(ActiveFilter, {
  /**
   * @see ActiveFilter.domainSeparator
   */
  domainSeparator: ",",

  /**
   * The body of the filter
   * @type {string}
   */
  body: null
});

/**
 * Creates a content filter from a pre-parsed text representation
 *
 * @param {string} text         same as in Filter()
 * @param {string} [domains]
 *   domains part of the text representation
 * @param {string} [type]
 *   rule type, either:
 *     <li>"" for an element hiding filter</li>
 *     <li>"@" for an element hiding exception filter</li>
 *     <li>"?" for an element hiding emulation filter</li>
 *     <li>"$" for a snippet filter</li>
 * @param {string} body
 *   body part of the text representation, either a CSS selector or a snippet
 *   script
 * @return {ElemHideFilter|ElemHideException|
 *          ElemHideEmulationFilter|SnippetFilter|InvalidFilter}
 */
ContentFilter.fromText = function(text, domains, type, body)
{
  // We don't allow content filters which have any empty domains.
  // Note: The ContentFilter.prototype.domainSeparator is duplicated here, if
  // that changes this must be changed too.
  if (domains && /(^|,)~?(,|$)/.test(domains))
    return new InvalidFilter(text, "filter_invalid_domain");

  if (type == "@")
    return new ElemHideException(text, domains, body);

  if (type == "?" || type == "$")
  {
    // Element hiding emulation and snippet filters are inefficient so we need
    // to make sure that they're only applied if they specify active domains
    if (!(/,[^~][^,.]*\.[^,]/.test("," + domains) ||
          ("," + domains + ",").includes(",localhost,")))
    {
      return new InvalidFilter(text, type == "?" ?
                                       "filter_elemhideemulation_nodomain" :
                                       "filter_snippet_nodomain");
    }

    if (type == "?")
      return new ElemHideEmulationFilter(text, domains, body);

    return new SnippetFilter(text, domains, body);
  }

  return new ElemHideFilter(text, domains, body);
};

/**
 * Base class for element hiding filters
 * @param {string} text see {@link Filter Filter()}
 * @param {string} [domains] see {@link ContentFilter ContentFilter()}
 * @param {string} selector  CSS selector for the HTML elements that should be
 *                           hidden
 * @constructor
 * @augments ContentFilter
 */
function ElemHideBase(text, domains, selector)
{
  ContentFilter.call(this, text, domains, selector);
}
exports.ElemHideBase = ElemHideBase;

ElemHideBase.prototype = extend(ContentFilter, {
  /**
   * CSS selector for the HTML elements that should be hidden
   * @type {string}
   */
  get selector()
  {
    // Braces are being escaped to prevent CSS rule injection.
    return this.body.replace("{", "\\7B ").replace("}", "\\7D ");
  }
});

/**
 * Class for element hiding filters
 * @param {string} text see {@link Filter Filter()}
 * @param {string} [domains]  see {@link ElemHideBase ElemHideBase()}
 * @param {string} selector see {@link ElemHideBase ElemHideBase()}
 * @constructor
 * @augments ElemHideBase
 */
function ElemHideFilter(text, domains, selector)
{
  ElemHideBase.call(this, text, domains, selector);
}
exports.ElemHideFilter = ElemHideFilter;

ElemHideFilter.prototype = extend(ElemHideBase, {
  type: "elemhide"
});

/**
 * Class for element hiding exceptions
 * @param {string} text see {@link Filter Filter()}
 * @param {string} [domains]  see {@link ElemHideBase ElemHideBase()}
 * @param {string} selector see {@link ElemHideBase ElemHideBase()}
 * @constructor
 * @augments ElemHideBase
 */
function ElemHideException(text, domains, selector)
{
  ElemHideBase.call(this, text, domains, selector);
}
exports.ElemHideException = ElemHideException;

ElemHideException.prototype = extend(ElemHideBase, {
  type: "elemhideexception"
});

/**
 * Class for element hiding emulation filters
 * @param {string} text           see {@link Filter Filter()}
 * @param {string} domains        see {@link ElemHideBase ElemHideBase()}
 * @param {string} selector       see {@link ElemHideBase ElemHideBase()}
 * @constructor
 * @augments ElemHideBase
 */
function ElemHideEmulationFilter(text, domains, selector)
{
  ElemHideBase.call(this, text, domains, selector);
}
exports.ElemHideEmulationFilter = ElemHideEmulationFilter;

ElemHideEmulationFilter.prototype = extend(ElemHideBase, {
  type: "elemhideemulation"
});

/**
 * Class for snippet filters
 * @param {string} text see Filter()
 * @param {string} [domains] see ContentFilter()
 * @param {string} script    Script that should be executed
 * @constructor
 * @augments ContentFilter
 */
function SnippetFilter(text, domains, script)
{
  ContentFilter.call(this, text, domains, script);
}
exports.SnippetFilter = SnippetFilter;

SnippetFilter.prototype = extend(ContentFilter, {
  type: "snippet",

  /**
   * Script that should be executed
   * @type {string}
   */
  get script()
  {
    return this.body;
  }
});
