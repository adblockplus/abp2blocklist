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

function runTest(test, assertions)
{
  // All the assertions are run in parallel but we wait for all of them to
  // finish before moving on to the next test.
  test.expect(assertions.length);
  Promise.all(assertions).then(() => test.done());
}

function testRules(test, filters, expected, transformFunction, options)
{
  let blockerList = new ContentBlockerList(options);
  for (let filter of filters)
    blockerList.addFilter(Filter.fromText(filter));

  return blockerList.generateRules().then(rules =>
  {
    if (transformFunction)
      rules = transformFunction(rules);

    test.deepEqual(rules, expected);
  });
}

exports.generateRules = {
  testElementHiding: function(test)
  {
    runTest(test, [
      testRules(test, ["##.whatever"], [
        {trigger: {"url-filter": "^https?://",
                   "url-filter-is-case-sensitive": true},
         action: {type: "css-display-none", selector: ".whatever"}}
      ]),
      testRules(test, ["test.com##.whatever"], [
        {trigger: {"url-filter": "^https?://([^/:]*\\.)?test\\.com[/:]",
                   "url-filter-is-case-sensitive": true},
         action: {type: "css-display-none", selector: ".whatever"}}
      ])
    ]);
  },

  testElementHidingExceptions: function(test)
  {
    runTest(test, [
      testRules(test, [
        "##.whatever",
        "test.com,anothertest.com###something",
        "@@||special.test.com^$elemhide",
        "@@||test.com^$generichide",
        "@@||anothertest.com^$elemhide",
        "@@^something^$elemhide",
        "@@^anything^$generichide"
      ], [
        ["^https?://", ["*test.com", "*special.test.com", "*anothertest.com"]],
        ["^https?://([^/:]*\\.)?test\\.com[/:]", ["*special.test.com"]]
      ], rules => rules.map(rule => [rule.trigger["url-filter"],
                                     rule.trigger["unless-domain"]])),

      testRules(test, ["#@#whatever"], []),
      testRules(test, ["test.com#@#whatever"], []),
      testRules(test, ["~test.com#@#whatever"], []),

      // We currently completely ignore any element hiding filters that have the
      // same selector as an element hiding exception. In these examples
      // #whatever should be hidden for all domains not ending in test.com
      // instead of nowhere!
      testRules(test, ["test.com#@#whatever", "##whatever"], []),
      testRules(test, ["~test.com##whatever"], [])
    ]);
  },

  testRequestFilters: function(test)
  {
    runTest(test, [
      testRules(test, [
        "/foo", "||test.com^", "http://example.com/foo", "^foo^"
      ], [
        {
          trigger: {
            "url-filter": "^[^:]+:(//)?.*/foo",
            "resource-type": ["image", "style-sheet", "script", "font",
                              "media", "raw"]
          },
          action: {type: "block"}
        },
        {
          trigger: {
            "url-filter":
              "^[^:]+:(//)?([^/]+\\.)?test\\.com([^-_.%a-z0-9].*)?$",
            "url-filter-is-case-sensitive": true,
            "resource-type": ["image", "style-sheet", "script", "font",
                              "media", "raw", "document"],
            "unless-top-url": [
              "^[^:]+:(//)?([^/]+\\.)?test\\.com([^-_.%a-z0-9].*)?$"
            ],
            "top-url-filter-is-case-sensitive": true
          },
          action: {type: "block"}
        },
        {
          trigger: {
            "url-filter": "^http://example\\.com/foo",
            "resource-type": ["image", "style-sheet", "script", "font",
                              "media", "raw", "document"],
            "unless-top-url": ["^http://example\\.com/foo"]
          },
          action: {type: "block"}
        },
        {
          trigger: {
            "url-filter": "^[^:]+:(//)?.*http://example\\.com/foo",
            "resource-type": ["image", "style-sheet", "script", "font",
                              "media", "raw", "document"],
            "unless-top-url": ["^[^:]+:(//)?.*http://example\\.com/foo"]
          },
          action: {type: "block"}
        },
        {
          trigger: {
            "url-filter":
              "^[^:]+:(//)?(.*[^-_.%A-Za-z0-9])?foo([^-_.%A-Za-z0-9].*)?$",
            "resource-type": ["image", "style-sheet", "script", "font",
                              "media", "raw"]
          },
          action: {type: "block"}
        }
      ]),

      testRules(test, ["||example.com"], [
        {trigger: {"url-filter": "^[^:]+:(//)?([^/]+\\.)?example\\.com",
                   "url-filter-is-case-sensitive": true,
                   "resource-type": ["image", "style-sheet", "script", "font",
                                     "media", "raw", "document"],
                   "unless-top-url": ["^[^:]+:(//)?([^/]+\\.)?example\\.com"],
                   "top-url-filter-is-case-sensitive": true},

         action: {type: "block"}}
      ]),

      // Rules which would match no resource-types shouldn't be generated.
      testRules(test, ["foo$document", "||foo.com$document"], [])
    ]);
  },

  testRequestFilterExceptions: function(test)
  {
    runTest(test, [
      testRules(test, ["@@example.com"], [
        {trigger: {"url-filter": "^[^:]+:(//)?.*example\\.com",
                   "resource-type": ["image", "style-sheet", "script", "font",
                                     "media", "raw", "document"]},
         action: {type: "ignore-previous-rules"}}
      ]),

      testRules(test, ["@@||example.com"], [
        {trigger: {"url-filter": "^[^:]+:(//)?([^/]+\\.)?example\\.com",
                   "url-filter-is-case-sensitive": true,
                   "resource-type": ["image", "style-sheet", "script", "font",
                                     "media", "raw", "document"]},
         action: {type: "ignore-previous-rules"}}
      ])
    ]);
  },

  testElementIDattributeFormat: function(test)
  {
    runTest(test, [
      testRules(test,
                ["###example", "test.com###EXAMPLE"],
                ["[id=example]", "[id=EXAMPLE]"],
                rules => rules.map(rule => rule.action.selector))
    ]);
  },

  testDomainWhitelisting: function(test)
  {
    runTest(test, [
      testRules(test, ["@@||example.com^$document"], [
        {
          trigger: {
            "url-filter": ".*",
            "if-domain": ["*example.com"]
          },
          action: {type: "ignore-previous-rules"}
        }
      ]),
      testRules(test, ["@@||example.com^$document,image"], [
        {
          trigger: {
            "url-filter": ".*",
            "if-domain": ["*example.com"]
          },
          action: {type: "ignore-previous-rules"}
        },
        {
          trigger: {
            "url-filter":
              "^https?://([^/]+\\.)?example\\.com([^-_.%a-z0-9].*)?$",
            "url-filter-is-case-sensitive": true,
            "resource-type": ["image"]
          },
          action: {type: "ignore-previous-rules"}
        }
      ]),
      testRules(test, ["@@||example.com/path^$font,document"], [
        {
          trigger: {
            "url-filter":
              "^https?://([^/]+\\.)?example\\.com/path([^-_.%A-Za-z0-9].*)?$",
            "resource-type": ["font"]
          },
          action: {type: "ignore-previous-rules"}
        }
      ])
    ]);
  },

  testGenericblockExceptions: function(test)
  {
    runTest(test, [
      testRules(test, ["^ad.jpg|", "@@||example.com^$genericblock"],
                [[undefined, ["*example.com"]]],
                rules => rules.map(rule => [rule.trigger["if-domain"],
                                            rule.trigger["unless-domain"]])),
      testRules(test, ["^ad.jpg|$domain=test.com",
                       "@@||example.com^$genericblock"],
                [[["*test.com"], undefined]],
                rules => rules.map(rule => [rule.trigger["if-domain"],
                                            rule.trigger["unless-domain"]])),
      testRules(test, ["^ad.jpg|$domain=~test.com",
                       "@@||example.com^$genericblock"],
                [[undefined, ["*test.com", "*example.com"]]],
                rules => rules.map(rule => [rule.trigger["if-domain"],
                                            rule.trigger["unless-domain"]]))
    ]);
  },

  testRuleOrdering: function(test)
  {
    runTest(test, [
      testRules(
        test,
        ["/ads.jpg", "@@example.com", "test.com#@#foo", "##bar"],
        ["css-display-none", "block", "ignore-previous-rules"],
        rules => rules.map(rule => rule.action.type)
      ),
      testRules(
        test,
        ["@@example.com", "##bar", "/ads.jpg", "test.com#@#foo"],
        ["css-display-none", "block", "ignore-previous-rules"],
        rules => rules.map(rule => rule.action.type)
      )
    ]);
  },

  testRequestTypeMapping: function(test)
  {
    runTest(test, [
      testRules(
        test,
        ["1", "2$image", "3$stylesheet", "4$script", "5$font", "6$media",
         "7$popup", "8$object", "9$object_subrequest", "10$xmlhttprequest",
         "11$websocket", "12$webrtc",
         "13$ping", "14$subdocument", "15$other", "16$IMAGE",
         "17$script,PING,Popup", "18$~image"],
        [["image", "style-sheet", "script", "font", "media", "raw"],
         ["image"],
         ["style-sheet"],
         ["script"],
         ["font"],
         ["media"],
         ["popup"],
         ["media"],
         ["raw"],
         ["raw"],
         ["raw"], // WebSocket
         ["raw"], // WebRTC: STUN
         ["raw"], // WebRTC: TURN
         ["raw"],
         ["raw"],
         ["image"],
         ["script", "popup", "raw" ],
         ["style-sheet", "script", "font", "media", "raw"]],
        rules => rules.map(rule => rule.trigger["resource-type"])
      )
    ]);
  },

  testUnsupportedfilters: function(test)
  {
    runTest(test, [
      // These types of filters are currently completely unsupported.
      testRules(test, ["foo$sitekey=bar"], [])
    ]);
  },

  testFilterOptions: function(test)
  {
    runTest(test, [
      testRules(test, ["1$domain=foo.com"], ["*foo.com"],
                rules => rules[0]["trigger"]["if-domain"]),
      testRules(test, ["2$third-party"], ["third-party"],
                rules => rules[0]["trigger"]["load-type"]),
      testRules(test, ["foo$match_case"], true,
                rules => rules[0]["trigger"]["url-filter-is-case-sensitive"]),

      // Test subdomain exceptions.
      testRules(test, ["1$domain=foo.com|~bar.foo.com"],
                ["foo.com", "www.foo.com"],
                rules => rules[0]["trigger"]["if-domain"]),
      testRules(test, ["1$domain=foo.com|~www.foo.com"],
                ["foo.com"],
                rules => rules[0]["trigger"]["if-domain"])
    ]);
  },

  testUnicode: function(test)
  {
    runTest(test, [
      testRules(test, ["$domain=🐈.cat"], ["*xn--zn8h.cat"],
                rules => rules[0]["trigger"]["if-domain"]),
      testRules(test, ["||🐈"], "^[^:]+:(//)?([^/]+\\.)?xn--zn8h",
                rules => rules[0]["trigger"]["url-filter"]),
      testRules(test, ["🐈$domain=🐈.cat"], "^[^:]+:(//)?.*%F0%9F%90%88",
                rules => rules[0]["trigger"]["url-filter"]),
      testRules(test, ["🐈%F0%9F%90%88$domain=🐈.cat"],
                "^[^:]+:(//)?.*%F0%9F%90%88%F0%9F%90%88",
                rules => rules[0]["trigger"]["url-filter"]),
      testRules(test, ["###🐈"], "[id=🐈]",
                rules => rules[0]["action"]["selector"])
    ]);
  },

  testWebSocket: function(test)
  {
    runTest(test, [
      testRules(test, ["foo$websocket"], [
        {trigger: {"url-filter": "^wss?://.*foo", "resource-type": ["raw"]},
         action: {type: "block"}}
      ])
    ]);
  },

  testWebRTC: function(test)
  {
    runTest(test, [
      testRules(test, ["foo$webrtc"], [
        {trigger: {"url-filter": "^stuns?:.*foo", "resource-type": ["raw"]},
         action: {type: "block"}},
        {trigger: {"url-filter": "^turns?:.*foo", "resource-type": ["raw"]},
         action: {type: "block"}}
      ])
    ]);
  },

  testMerging: function(test)
  {
    runTest(test, [
      // Single character substitutions, deletions, and insertions.
      testRules(test, ["/ads", "/adv"], ["^[^:]+:(//)?.*/ad[sv]"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/ads", "/advs"], ["^[^:]+:(//)?.*/adv?s"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/advs", "/ads"], ["^[^:]+:(//)?.*/adv?s"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adts", "/advs", "/ads"], ["^[^:]+:(//)?.*/ad[tv]?s"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/ads", "/adts", "/advs"], ["^[^:]+:(//)?.*/ad[tv]?s"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adts", "/ads", "/advs"], ["^[^:]+:(//)?.*/ad[tv]?s"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/ax", "/adx", "/adsx", "/advx"],
                ["^[^:]+:(//)?.*/ax", "^[^:]+:(//)?.*/ad[sv]?x"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adx", "/ax", "/adsx", "/advx"],
                ["^[^:]+:(//)?.*/ax", "^[^:]+:(//)?.*/ad[sv]?x"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adsx", "/advx", "/adx", "/ax"],
                ["^[^:]+:(//)?.*/ad[sv]?x", "^[^:]+:(//)?.*/ax"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adsx", "/advx", "/ax", "/adx"],
                ["^[^:]+:(//)?.*/ad[sv]?x", "^[^:]+:(//)?.*/ax"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/ad-", "/a-", "/ads-", "/adv-", "/adx-"],
                ["^[^:]+:(//)?.*/a-", "^[^:]+:(//)?.*/ad[svx]?-"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/ads-", "/a-", "/ad-", "/adv-", "/adx-"],
                ["^[^:]+:(//)?.*/ad[svx]?-", "^[^:]+:(//)?.*/a-"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),

      // Multiple character deletions and insertions.
      testRules(test, ["/ads", "/adxis"],
                ["^[^:]+:(//)?.*/ad(xi)?s"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adxsi", "/xsi"],
                ["^[^:]+:(//)?.*/(ad)?xsi"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adxsi", "/ai"],
                ["^[^:]+:(//)?.*/a(dxs)?i"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),

      // Both single and multiple character edits combined.
      testRules(test, ["/adq", "/adxsiq", "/xsiq", "/axsiq", "/bxsiq"],
                ["^[^:]+:(//)?.*/ad(xsi)?q", "^[^:]+:(//)?.*/[ab]?xsiq"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),

      testRules(test, ["/adsq", "/aq", "/adq", "/advq", "/adxq", "/adxsq"],
                ["^[^:]+:(//)?.*/ad[svx]?q", "^[^:]+:(//)?.*/a(dxs)?q"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adxsq", "/aq", "/adq", "/adsq", "/advq", "/adxq"],
                ["^[^:]+:(//)?.*/a(dxs)?q", "^[^:]+:(//)?.*/ad[svx]?q"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adxsq", "/aq", "/adsq", "/adq", "/advq", "/adxq"],
                ["^[^:]+:(//)?.*/a(dxs)?q", "^[^:]+:(//)?.*/ad[svx]?q"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adxsq", "/aq", "/adsq", "/advq", "/adq", "/adxq"],
                ["^[^:]+:(//)?.*/a(dxs)?q", "^[^:]+:(//)?.*/ad[svx]?q"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adsxiq", "/adxsq", "/aq", "/adsq", "/advq", "/adq",
                       "/adxq"],
                ["^[^:]+:(//)?.*/a(dsxi)?q", "^[^:]+:(//)?.*/adxsq",
                 "^[^:]+:(//)?.*/ad[svx]?q"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adxsiq", "/adsxiq", "/adxsq", "/aq", "/adsq", "/advq",
                       "/adq", "/adxq"],
                ["^[^:]+:(//)?.*/adxsi?q", "^[^:]+:(//)?.*/a(dsxi)?q",
                 "^[^:]+:(//)?.*/ad[svx]?q"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),

      // Given the 6 rules "adsi", "bdsi", "advi", "bdvi", "adxi", and "bdxi",
      // we want the 2 rules "ad[svx]i" and "bd[svx]i", not the 3 rules
      // "[ab]dsi", "[ab]dvi", and "[ab]dxi"
      testRules(test, ["/adsi", "/bdsi", "/advi", "/bdvi", "/adxi", "/bdxi"],
                ["^[^:]+:(//)?.*/ad[svx]i", "^[^:]+:(//)?.*/bd[svx]i"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/adsi", "/bdsi", "/advi", "/bdvi", "/bdxi"],
                ["^[^:]+:(//)?.*/ad[sv]i", "^[^:]+:(//)?.*/bd[svx]i"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),

      // Make sure there's no merge where there are special characters in the
      // delta.
      testRules(test, ["/ads?q", "/adsq"],
                ["^[^:]+:(//)?.*/ads\\?q", "^[^:]+:(//)?.*/adsq"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/ads?", "/ads-"],
                ["^[^:]+:(//)?.*/ads\\?", "^[^:]+:(//)?.*/ads-"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),
      testRules(test, ["/ads?-", "/ads-"],
                ["^[^:]+:(//)?.*/ads\\?-", "^[^:]+:(//)?.*/ads-"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"}),

      // Redundant rules should be discarded.
      testRules(test, ["/ad", "/ads", "/advertisement"],
                ["^[^:]+:(//)?.*/ad"],
                rules => rules.map(rule => rule.trigger["url-filter"]),
                {merge: "all"})
    ]);
  }
};
