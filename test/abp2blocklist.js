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

"use strict";

let Filter = require("filterClasses").Filter;
let ContentBlockerList = require("../lib/abp2blocklist.js").ContentBlockerList;

function testRules(test, filters, expected, transformFunction)
{
  let blockerList = new ContentBlockerList();
  for (let filter of filters)
    blockerList.addFilter(Filter.fromText(filter));

  let rules = blockerList.generateRules();
  if (transformFunction)
    rules = transformFunction(rules);

  test.deepEqual(rules, expected);
}

exports.generateRules = {
  testElementHiding: function(test)
  {
    testRules(test, ["##.whatever"], [
      {trigger: {"url-filter": "^https?://",
                 "url-filter-is-case-sensitive": true},
       action: {type: "css-display-none", selector: ".whatever"}}
    ]);
    testRules(test, ["test.com##.whatever"], [
      {trigger: {"url-filter": "^https?://([^/:]*\\.)?test\\.com[/:]",
                 "url-filter-is-case-sensitive": true},
       action: {type: "css-display-none", selector: ".whatever"}}
    ]);

    test.done();
  },

  testElementHidingExceptions: function(test)
  {
    // Element hiding rules should be in the following order: (1) generic
    // rules, (2) exceptions for generic rules, (3) domain-specific rules,
    // (4) exceptions for all rules.
    testRules(test, [
      "##.whatever",
      "test.com###something",
      "@@||special.test.com^$elemhide",
      "@@||test.com^$generichide"
    ], [
      ["^https?://", "css-display-none"],
      ["^https?://([^/]+\\.)?test\\.com", "ignore-previous-rules"],
      ["^https?://([^/:]*\\.)?test\\.com[/:]", "css-display-none"],
      ["^https?://([^/]+\\.)?special\\.test\\.com", "ignore-previous-rules"]
    ], rules => rules.map(rule => [rule.trigger["url-filter"],
                                   rule.action.type]));

    testRules(test, ["#@#whatever"], []);
    testRules(test, ["test.com#@#whatever"], []);
    testRules(test, ["~test.com#@#whatever"], []);

    // We currently completely ignore any element hiding filters that have the
    // same selector as an element hiding exception. In these examples #whatever
    // should be hidden for all domains not ending in test.com instead of
    // nowhere!
    testRules(test, ["test.com#@#whatever", "##whatever"], []);
    testRules(test, ["~test.com##whatever"], []);

    test.done();
  },

  testRequestFilters: function(test)
  {
    testRules(test, ["/foo", "||test.com", "http://example.com/foo"], [
      {trigger: {"url-filter": "^https?://.*/foo",
                 "resource-type": ["image", "style-sheet", "script", "font",
                                   "media", "raw", "document"],
                 "unless-top-url": ["^https?://.*/foo"]},
       action: {type: "block"}},
      {trigger: {"url-filter": "^https?://([^/]+\\.)?test\\.com",
                 "url-filter-is-case-sensitive": true,
                 "resource-type": ["image", "style-sheet", "script", "font",
                                   "media", "raw", "document"],
                 "unless-top-url": ["^https?://([^/]+\\.)?test\\.com"],
                 "top-url-filter-is-case-sensitive": true},
       action: {type: "block"}},
      {trigger: {"url-filter": "http://example\\.com/foo",
                 "resource-type": ["image", "style-sheet", "script", "font",
                                   "media", "raw", "document"],
                 "unless-top-url": ["http://example\\.com/foo"]},
       action: {type: "block"}}
    ]);

    testRules(test, ["||example.com"], [
      {trigger: {"url-filter": "^https?://([^/]+\\.)?example\\.com",
                 "url-filter-is-case-sensitive": true,
                 "resource-type": ["image", "style-sheet", "script", "font",
                                   "media", "raw", "document"],
                 "unless-top-url": ["^https?://([^/]+\\.)?example\\.com"],
                 "top-url-filter-is-case-sensitive": true},

       action: {type: "block"}}
    ]);

    // Rules which would match no resource-types shouldn't be generated.
    testRules(test, ["foo$document", "||foo.com$document"], []);

    test.done();
  },

  testRequestFilterExceptions: function(test)
  {
    testRules(test, ["@@example.com"], [
      {trigger: {"url-filter": "^https?://.*example\\.com",
                 "resource-type": ["image", "style-sheet", "script", "font",
                                   "media", "raw", "document"]},
       action: {type: "ignore-previous-rules"}}
    ]);

    testRules(test, ["@@||example.com"], [
      {trigger: {"url-filter": "^https?://([^/]+\\.)?example\\.com",
                 "url-filter-is-case-sensitive": true,
                 "resource-type": ["image", "style-sheet", "script", "font",
                                   "media", "raw", "document"]},
       action: {type: "ignore-previous-rules"}}
    ]);

    test.done();
  },

  testElementIDattributeFormat: function(test)
  {
    testRules(test,
              ["###example", "test.com###EXAMPLE"],
              ["[id=example]", "[id=EXAMPLE]"],
              rules => rules.map(rule => rule.action.selector));

    test.done();
  },

  testDomainWhitelisting: function(test)
  {
    testRules(test, ["@@||example.com^$document"], [
      {trigger: {"url-filter": ".*",
                 "if-domain": ["*example.com"]},
       action: {type: "ignore-previous-rules"}}
    ]);
    testRules(test, ["@@||example.com^$document,image"], [
      {trigger: {"url-filter": ".*",
                 "if-domain": ["*example.com"]},
       action: {type: "ignore-previous-rules"}},
      {trigger: {"url-filter": "^https?://([^/]+\\.)?example\\.com",
                 "url-filter-is-case-sensitive": true,
                 "resource-type": ["image"]},
       action: {type: "ignore-previous-rules"}}
    ]);
    testRules(test, ["@@||example.com/path^$font,document"], [
      {trigger: {"url-filter": "^https?://([^/]+\\.)?example\\.com/path",
                 "resource-type": ["font"]},
       action: {type: "ignore-previous-rules"}}
    ]);

    test.done();
  },

  testGenericblockExceptions: function(test)
  {
    testRules(test, ["^ad.jpg|", "@@||example.com^$genericblock"],
              [[undefined, ["*example.com"]]],
              rules => rules.map(rule => [rule.trigger["if-domain"],
                                          rule.trigger["unless-domain"]]));
    testRules(test, ["^ad.jpg|$domain=test.com",
                     "@@||example.com^$genericblock"],
              [[["*test.com"], undefined]],
              rules => rules.map(rule => [rule.trigger["if-domain"],
                                          rule.trigger["unless-domain"]]));
    testRules(test, ["^ad.jpg|$domain=~test.com",
                     "@@||example.com^$genericblock"],
              [[undefined, ["*test.com", "*example.com"]]],
              rules => rules.map(rule => [rule.trigger["if-domain"],
                                          rule.trigger["unless-domain"]]));

    test.done();
  },

  testRuleOrdering: function(test)
  {
    testRules(
      test,
      ["/ads.jpg", "@@example.com", "test.com#@#foo", "##bar"],
      ["css-display-none", "block", "ignore-previous-rules"],
      rules => rules.map(rule => rule.action.type)
    );
    testRules(
      test,
      ["@@example.com", "##bar", "/ads.jpg", "test.com#@#foo"],
      ["css-display-none", "block", "ignore-previous-rules"],
      rules => rules.map(rule => rule.action.type)
    );

    test.done();
  },

  testRequestTypeMapping: function(test)
  {
    testRules(
      test,
      ["1", "2$image", "3$stylesheet", "4$script", "5$font", "6$media",
       "7$popup", "8$object", "9$object_subrequest", "10$xmlhttprequest",
       "11$ping", "12$subdocument", "13$other", "14$IMAGE",
       "15$script,PING,Popup", "16$~image"],
      [["image", "style-sheet", "script", "font", "media", "raw", "document" ],
       ["image"],
       ["style-sheet"],
       ["script"],
       ["font"],
       ["media"],
       ["popup"],
       ["media"],
       ["raw"],
       ["raw"],
       ["raw"],
       ["document"],
       ["raw"],
       ["image"],
       ["script", "popup", "raw" ],
       ["style-sheet", "script", "font", "media", "raw", "document"]],
      rules => rules.map(rule => rule.trigger["resource-type"])
    );

    test.done();
  },

  testUnsupportedfilters: function(test)
  {
    // These types of filters are currently completely unsupported.
    testRules(test, ["foo$sitekey=bar"], []);

    test.done();
  },

  testFilterOptions: function(test)
  {
    testRules(test, ["1$domain=foo.com"], ["*foo.com"],
              rules => rules[0]["trigger"]["if-domain"]);
    testRules(test, ["2$third-party"], ["third-party"],
              rules => rules[0]["trigger"]["load-type"]);
    testRules(test, ["foo$match_case"], true,
              rules => rules[0]["trigger"]["url-filter-is-case-sensitive"]);

    // Test subdomain exceptions.
    testRules(test, ["1$domain=foo.com|~bar.foo.com"],
              ["foo.com", "www.foo.com"],
              rules => rules[0]["trigger"]["if-domain"]);
    testRules(test, ["1$domain=foo.com|~www.foo.com"],
              ["foo.com"],
              rules => rules[0]["trigger"]["if-domain"]);

    test.done();
  },

  testUnicode: function(test)
  {
    testRules(test, ["$domain=🐈.cat"], ["*xn--zn8h.cat"],
              rules => rules[0]["trigger"]["if-domain"]);
    testRules(test, ["🐈$domain=🐈.cat"], "^https?://.*🐈",
              rules => rules[0]["trigger"]["url-filter"]);
    testRules(test, ["###🐈"], "[id=🐈]",
              rules => rules[0]["action"]["selector"]);

    test.done();
  }
};
