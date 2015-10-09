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

```
node abp2blocklist.js < easylist.txt > easylist.json
```
