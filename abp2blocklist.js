var readline = require("readline");
var punycode = require("punycode");
var filterClasses = require("./adblockplus.js");

var typeMap = filterClasses.RegExpFilter.typeMap;

var requestFilters = [];
var requestExceptions = [];
var documentExceptions = [];
var elemhideFilters = [];
var elemhideExceptions = [];
var elemhideSelectorExceptions = Object.create(null);

function recordException(filter) {
	if (filter.contentType & (typeMap.IMAGE
	                        | typeMap.STYLESHEET
	                        | typeMap.SCRIPT
	                        | typeMap.FONT
	                        | typeMap.MEDIA
	                        | typeMap.POPUP
	                        | typeMap.OBJECT
	                        | typeMap.OBJECT_SUBREQUEST
	                        | typeMap.XMLHTTPREQUEST
	                        | typeMap.SUBDOCUMENT
	                        | typeMap.OTHER))
		requestExceptions.push(filter);

	if (filter.contentType & typeMap.DOCUMENT)
		documentExceptions.push(filter);

	if (filter.contentType & typeMap.ELEMHIDE)
		elemhideExceptions.push(filter);
}

function parseDomains(domains, included, excluded) {
	for (var domain in domains) {
		if (domain != "") {
			var enabled = domains[domain];
			domain = punycode.toASCII(domain.toLowerCase());

			if (!enabled)
				excluded.push(domain);
			else if (!domains[""])
				included.push(domain);
		}
	}
}

function recordSelectorException(filter) {
	var domains = elemhideSelectorExceptions[filter.selector];
	if (!domains)
		domains = elemhideSelectorExceptions[filter.selector] = [];

	var excluded = [];
	parseDomains(filter.domains, domains, excluded);

	console.assert(!filter.domains[""], filter.text);
	console.assert(excluded.length == 0, filter.text);
}

function parseFilter(line) {
	var filter = filterClasses.Filter.fromText(line);

	if (filter.sitekey)
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

function joinRegExp(arr) {
	if (arr.length == 1)
		return arr[0];
	return "(?:" + arr.join("|") + ")";
}

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchDomains(domains) {
	return "([^/]*\\.)?" + joinRegExp(domains.map(escapeRegExp)) + "/";
}

function convertElemHideFilter(filter) {
	var included = [];
	var excluded = [];
	parseDomains(filter.domains, included, excluded);
	if (filter.selector in elemhideSelectorExceptions)
		excluded = excluded.concat(elemhideSelectorExceptions[filter.selector]);

	var regexp = "^https?://";
	if (excluded.length > 0)
		regexp += "(?!" + matchDomains(excluded) + ")";
	if (included.length > 0)
		regexp += matchDomains(included);

	return {
		trigger: {
			"url-filter": regexp
		},
		action: {
			type: "css-display-none",
			selector: filter.selector
		}
	};
}

function toRegExp(text) {
	var result = "";
	var lastIndex = text.length - 1;

	for (var i = 0; i < text.length; i++)
	{
		var c = text[i];

		switch (c)
		{
			case "*":
				if (result.length > 0 && i < lastIndex && text[i + 1] != "*")
					result += ".*";
				break;
			case "^":
				var chars = "\\x00-\\x24\\x26-\\x2C\\x2F\\x3A-\\x40\\x5B-\\x5E\\x60\\x7B-\\x7F";
				if (i == lastIndex)
					result += "(?![^" + chars + "])";
				else
					result += "[" + chars + "]";
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

function getRegExpSource(filter) {
	var source;
	if (filter.regexpSource)
		source = toRegExp(filter.regexpSource.replace(
			// Safari expects punycode, filter lists use unicode
			/^(\|\||\|?https?:\/\/)([\w\-.*\u0080-\uFFFF]+)/i,
			function (match, prefix, domain) {
				return prefix + punycode.toASCII(domain);
			}
		));
	else
		source = filter.regexp.source;

	// Limit rules to to HTTP(S) URLs
	if (!/^(\^|http)/i.test(source))
		source = "^(?=https?://).*" + source;

	return source;
}

function addDomainAndThirdPartyOptions(trigger, filter) {
	if (filter.thirdParty != null)
		trigger["load-type"] = filter.thirdParty ? "third-party" : "first-party";

	var included = [];
	var excluded = [];
	parseDomains(filter.domains, included, excluded);
	if (included.length > 0)
		trigger["if-domain"] = included;
	if (excluded.length > 0)
		trigger["unless-domain"] = excluded;
}

function convertRecursiveException(filter) {
	var rule = {
		trigger: {
			"url-filter": getRegExpSource(filter)
		},
		action: {
			// Not yet supported
			type: "ignore-previous-rules-in-document"
		}
	};

	addDomainAndThirdPartyOptions(rule.trigger, filter);
	return rule;
}


function getResourceTypes(filter) {
	var types = [];

	if (filter.contentType & typeMap.IMAGE)
		types.push("image");
	if (filter.contentType & typeMap.STYLESHEET)
		types.push("style-sheet");
	if (filter.contentType & typeMap.SCRIPT)
		types.push("script");
	if (filter.contentType & typeMap.FONT)
		types.push("font");
	if (filter.contentType & typeMap.MEDIA)
		types.push("media");
	if (filter.contentType & typeMap.POPUP)
		types.push("popup");
	if (filter.contentType & (typeMap.XMLHTTPREQUEST | typeMap.OTHER))
		types.push("raw");

	// Not yet supported
	if (filter.contentType & typeMap.SUBDOCUMENT)
		types.push("subdocument");
	if (filter.contentType & typeMap.OBJECT)
		types.push("object");
	if (filter.contentType & typeMap.OBJECT_SUBREQUEST)
		types.push("object-subrequest");

	return types;
}

function convertRequestFilter(filter) {
	var rule = {
		trigger: {
			"url-filter": getRegExpSource(filter),
			"resource-type": getResourceTypes(filter)
		},
		action: {
			type: "block"
		}
	};

	// Not yet supported
	if (filter.collapse != false)
		rule.action.collapse = true;

	addDomainAndThirdPartyOptions(rule.trigger, filter);
	return rule;
}

function convertRequestException(filter, opts) {
	var rule = {
		trigger: {
			"url-filter": getRegExpSource(filter),
			"resource-type": getResourceTypes(filter)
		},
		action: {
			type: "ignore-previous-rules"
		}
	};

	addDomainAndThirdPartyOptions(rule.trigger, filter);
	return rule;
}

function logRules() {
	var rules = [];
	var i;

	for (i = 0; i < elemhideFilters.length; i++)
		rules.push(convertElemHideFilter(elemhideFilters[i]));
	for (i = 0; i < elemhideExceptions.length; i++)
		rules.push(convertRecursiveException(elemhideExceptions[i]));
	for (i = 0; i < requestFilters.length; i++)
		rules.push(convertRequestFilter(requestFilters[i]));
	for (i = 0; i < requestExceptions.length; i++)
		rules.push(convertRequestException(requestExceptions[i]));
	for (i = 0; i < documentExceptions.length; i++)
		rules.push(convertRecursiveException(documentExceptions[i]));

	console.log(JSON.stringify(rules, null, "\t"));
}

var rl = readline.createInterface({input: process.stdin, terminal: false});
rl.on("line", parseFilter);
rl.on("close", logRules);
