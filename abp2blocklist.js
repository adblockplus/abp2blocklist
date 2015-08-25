var readline = require("readline");
var punycode = require("punycode");
var tldjs = require("tldjs");
var filterClasses = require("./adblockplus.js");

var typeMap = filterClasses.RegExpFilter.typeMap;

var requestFilters = [];
var requestExceptions = [];
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

	parseDomains(filter.domains, domains, []);
}

function parseFilter(line) {
	var filter = filterClasses.Filter.fromText(line);

	if (filter.sitekey)
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

function escapeRegExp(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchDomain(domain) {
	return "^https?://([^/:]*\\.)?" + escapeRegExp(domain) + "[/:]";
}

function convertElemHideFilter(filter) {
	var included = [];
	var excluded = [];
	var rules = [];

	parseDomains(filter.domains, included, excluded);

	if (excluded.length == 0 && !(filter.selector in elemhideSelectorExceptions) && included.length <= 1) {
		var action = {
			type: "css-display-none",
			selector: filter.selector
		};

		for (var i = 0; i < included.length; i++)
			rules.push({
				trigger: {"url-filter": matchDomain(included[i])},
				action: action
			});

		if (included.length == 0)
			rules.push({
				trigger: {"url-filter": "^https?://"},
				action: action
			});
	}

	return rules;
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

function getRegExpSource(filter) {
	var source = toRegExp(filter.regexpSource.replace(
		// Safari expects punycode, filter lists use unicode
		/^(\|\||\|?https?:\/\/)([\w\-.*\u0080-\uFFFF]+)/i,
		function (match, prefix, domain) {
			return prefix + punycode.toASCII(domain);
		}
	));

	// Limit rules to to HTTP(S) URLs
	if (!/^(\^|http)/i.test(source))
		source = "^https?://.*" + source;

	return source;
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
	if (filter.contentType & (typeMap.MEDIA | typeMap.OBJECT))
		types.push("media");
	if (filter.contentType & typeMap.POPUP)
		types.push("popup");
	if (filter.contentType & (typeMap.XMLHTTPREQUEST | typeMap.OBJECT_SUBREQUEST | typeMap.OTHER))
		types.push("raw");
	if (filter.contentType & typeMap.SUBDOCUMENT)
		types.push("document");

	return types;
}

function addDomainPrefix(domains) {
	var result = [];

	for (var i = 0; i < domains.length; i++) {
		var domain = domains[i];
		result.push(domain);

		if (tldjs.getSubdomain(domain) == "")
			result.push("www." + domain);
	}

	return result;
}

function convertFilter(filter, action, withResourceTypes) {
	var trigger = {"url-filter": getRegExpSource(filter)};
	var included = [];
	var excluded = [];

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

function hasNonASCI(obj) {
	if (typeof obj == "string") {
		if (/[^\x00-\x7F]/.test(obj))
			return true;
	}

	if (typeof obj == "object") {
		var i;
		if (obj instanceof Array)
			for (i = 0; i < obj.length; i++)
				if (hasNonASCI(obj[i]))
					return true;

		var names = Object.getOwnPropertyNames(obj);
		for (i = 0; i < names.length; i++)
			if (hasNonASCI(obj[names[i]]))
				return true;
	}

	return false;
}

function logRules() {
	var rules = [];
	var i;

	function addRule(rule) {
		if (!hasNonASCI(rule))
			rules.push(rule);
	}

	for (i = 0; i < elemhideFilters.length; i++)
		convertElemHideFilter(elemhideFilters[i]).forEach(addRule);
	for (i = 0; i < elemhideExceptions.length; i++)
		addRule(convertFilter(elemhideExceptions[i], "ignore-previous-rules", false));
	for (i = 0; i < requestFilters.length; i++)
		addRule(convertFilter(requestFilters[i], "block", true));
	for (i = 0; i < requestExceptions.length; i++)
		addRule(convertFilter(requestExceptions[i], "ignore-previous-rules", true));

	console.log(JSON.stringify(rules, null, "\t"));
}

var rl = readline.createInterface({input: process.stdin, terminal: false});
rl.on("line", parseFilter);
rl.on("close", logRules);
