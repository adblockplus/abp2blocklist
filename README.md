# abp2blocklist

This is a script to convert [Adblock Plus filter lists](https://adblockplus.org/filters)
to [WebKit block lists](https://www.webkit.org/blog/3476/content-blockers-first-look/).

Note that WebKit content blockers are fairly limited. Hence, not all filters
can be converted (in a compatible way), and some differences compared to Adblock
Plus for other browsers are expected.

This script is used to convert the filter lists for
[Adblock Plus for iOS](https://adblockplus.org/releases/adblock-plus-10-for-ios-released).

## Requirements

The required packages can be installed via [NPM](https://npmjs.org):

```
npm install
```

## Usage

Create a WebKit block list `output.json` from the Adblock Plus filter list `input.txt`:
```
node abp2blocklist.js < input.txt > output.json
```

## Tests

Unit tests live in the `tests/` directory. To run the unit tests ensure you have
already installed the required packages (see above) and then type this command:

```
npm test
```

## Adblock Plus core code

To parse the Adblock Plus filters, we reuse parts of the core Adblock Plus code,
those files are inside the adblockpluscore directory.

If you need to refresh those files, run these commands (adjusting the paths as appropriate):

    cp adblockpluscore/lib/common.js abp2blocklist/adblockpluscore/lib/
    cp adblockpluscore/lib/coreUtils.js abp2blocklist/adblockpluscore/lib/
    cp adblockpluscore/lib/domain.js abp2blocklist/adblockpluscore/lib/
    cp adblockpluscore/data/resources.json abp2blocklist/adblockpluscore/data/
    cp adblockpluscore/data/publicSuffixList.json abp2blocklist/adblockpluscore/data/
    grep -vi filterNotifier adblockpluscore/lib/filterClasses.js > abp2blocklist/adblockpluscore/lib/filterClasses.js
