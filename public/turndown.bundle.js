(()=>{function W(e){for(var r=1;r<arguments.length;r++){var t=arguments[r];for(var n in t)Object.prototype.hasOwnProperty.call(t,n)&&(e[n]=t[n])}return e}function N(e,r){return Array(r+1).join(e)}function w(e){return e.replace(/^\n*/,"")}function S(e){for(var r=e.length;r>0&&e[r-1]===`
`;)r--;return e.substring(0,r)}function O(e){return S(w(e))}var _=["ADDRESS","ARTICLE","ASIDE","AUDIO","BLOCKQUOTE","BODY","CANVAS","CENTER","DD","DIR","DIV","DL","DT","FIELDSET","FIGCAPTION","FIGURE","FOOTER","FORM","FRAMESET","H1","H2","H3","H4","H5","H6","HEADER","HGROUP","HR","HTML","ISINDEX","LI","MAIN","MENU","NAV","NOFRAMES","NOSCRIPT","OL","OUTPUT","P","PRE","SECTION","TABLE","TBODY","TD","TFOOT","TH","THEAD","TR","UL"];function T(e){return A(e,_)}var D=["AREA","BASE","BR","COL","COMMAND","EMBED","HR","IMG","INPUT","KEYGEN","LINK","META","PARAM","SOURCE","TRACK","WBR"];function B(e){return A(e,D)}function j(e){return L(e,D)}var x=["A","TABLE","THEAD","TBODY","TFOOT","TH","TD","IFRAME","SCRIPT","AUDIO","VIDEO"];function G(e){return A(e,x)}function X(e){return L(e,x)}function A(e,r){return r.indexOf(e.nodeName)>=0}function L(e,r){return e.getElementsByTagName&&r.some(function(t){return e.getElementsByTagName(t).length})}var Y=[[/\\/g,"\\\\"],[/\*/g,"\\*"],[/^-/g,"\\-"],[/^\+ /g,"\\+ "],[/^(=+)/g,"\\$1"],[/^(#{1,6}) /g,"\\$1 "],[/`/g,"\\`"],[/^~~~/g,"\\~~~"],[/\[/g,"\\["],[/\]/g,"\\]"],[/^>/g,"\\>"],[/_/g,"\\_"],[/^(\d+)\. /g,"$1\\. "]];function P(e){return Y.reduce(function(r,t){return r.replace(t[0],t[1])},e)}var s={};s.paragraph={filter:"p",replacement:function(e){return`

`+e+`

`}};s.lineBreak={filter:"br",replacement:function(e,r,t){return t.br+`
`}};s.heading={filter:["h1","h2","h3","h4","h5","h6"],replacement:function(e,r,t){var n=Number(r.nodeName.charAt(1));if(t.headingStyle==="setext"&&n<3){var i=N(n===1?"=":"-",e.length);return`

`+e+`
`+i+`

`}else return`

`+N("#",n)+" "+e+`

`}};s.blockquote={filter:"blockquote",replacement:function(e){return e=O(e).replace(/^/gm,"> "),`

`+e+`

`}};s.list={filter:["ul","ol"],replacement:function(e,r){var t=r.parentNode;return t.nodeName==="LI"&&t.lastElementChild===r?`
`+e:`

`+e+`

`}};s.listItem={filter:"li",replacement:function(e,r,t){var n=t.bulletListMarker+"   ",i=r.parentNode;if(i.nodeName==="OL"){var a=i.getAttribute("start"),o=Array.prototype.indexOf.call(i.children,r);n=(a?Number(a)+o:o+1)+".  "}var u=/\n$/.test(e);return e=O(e)+(u?`
`:""),e=e.replace(/\n/gm,`
`+" ".repeat(n.length)),n+e+(r.nextSibling?`
`:"")}};s.indentedCodeBlock={filter:function(e,r){return r.codeBlockStyle==="indented"&&e.nodeName==="PRE"&&e.firstChild&&e.firstChild.nodeName==="CODE"},replacement:function(e,r,t){return`

    `+r.firstChild.textContent.replace(/\n/g,`
    `)+`

`}};s.fencedCodeBlock={filter:function(e,r){return r.codeBlockStyle==="fenced"&&e.nodeName==="PRE"&&e.firstChild&&e.firstChild.nodeName==="CODE"},replacement:function(e,r,t){for(var n=r.firstChild.getAttribute("class")||"",i=(n.match(/language-(\S+)/)||[null,""])[1],a=r.firstChild.textContent,o=t.fence.charAt(0),u=3,l=new RegExp("^"+o+"{3,}","gm"),f;f=l.exec(a);)f[0].length>=u&&(u=f[0].length+1);var d=N(o,u);return`

`+d+i+`
`+a.replace(/\n$/,"")+`
`+d+`

`}};s.horizontalRule={filter:"hr",replacement:function(e,r,t){return`

`+t.hr+`

`}};s.inlineLink={filter:function(e,r){return r.linkStyle==="inlined"&&e.nodeName==="A"&&e.getAttribute("href")},replacement:function(e,r){var t=y(r.getAttribute("href")),n=k(p(r.getAttribute("title"))),i=n?' "'+n+'"':"";return"["+e+"]("+t+i+")"}};s.referenceLink={filter:function(e,r){return r.linkStyle==="referenced"&&e.nodeName==="A"&&e.getAttribute("href")},replacement:function(e,r,t){var n=y(r.getAttribute("href")),i=p(r.getAttribute("title"));i&&(i=' "'+k(i)+'"');var a,o;switch(t.linkReferenceStyle){case"collapsed":a="["+e+"][]",o="["+e+"]: "+n+i;break;case"shortcut":a="["+e+"]",o="["+e+"]: "+n+i;break;default:var u=this.references.length+1;a="["+e+"]["+u+"]",o="["+u+"]: "+n+i}return this.references.push(o),a},references:[],append:function(e){var r="";return this.references.length&&(r=`

`+this.references.join(`
`)+`

`,this.references=[]),r}};s.emphasis={filter:["em","i"],replacement:function(e,r,t){return e.trim()?t.emDelimiter+e+t.emDelimiter:""}};s.strong={filter:["strong","b"],replacement:function(e,r,t){return e.trim()?t.strongDelimiter+e+t.strongDelimiter:""}};s.code={filter:function(e){var r=e.previousSibling||e.nextSibling,t=e.parentNode.nodeName==="PRE"&&!r;return e.nodeName==="CODE"&&!t},replacement:function(e){if(!e)return"";e=e.replace(/\r?\n|\r/g," ");for(var r=/^`|^ .*?[^ ].* $|`$/.test(e)?" ":"",t="`",n=e.match(/`+/gm)||[];n.indexOf(t)!==-1;)t=t+"`";return t+r+e+r+t}};s.image={filter:"img",replacement:function(e,r){var t=P(p(r.getAttribute("alt"))),n=y(r.getAttribute("src")||""),i=p(r.getAttribute("title")),a=i?' "'+k(i)+'"':"";return n?"!["+t+"]("+n+a+")":""}};function p(e){return e?e.replace(/(\n+\s*)+/g,`
`):""}function y(e){var r=e.replace(/([<>()])/g,"\\$1");return r.indexOf(" ")>=0?"<"+r+">":r}function k(e){return e.replace(/"/g,'\\"')}function I(e){this.options=e,this._keep=[],this._remove=[],this.blankRule={replacement:e.blankReplacement},this.keepReplacement=e.keepReplacement,this.defaultRule={replacement:e.defaultReplacement},this.array=[];for(var r in e.rules)this.array.push(e.rules[r])}I.prototype={add:function(e,r){this.array.unshift(r)},keep:function(e){this._keep.unshift({filter:e,replacement:this.keepReplacement})},remove:function(e){this._remove.unshift({filter:e,replacement:function(){return""}})},forNode:function(e){if(e.isBlank)return this.blankRule;var r;return(r=m(this.array,e,this.options))||(r=m(this._keep,e,this.options))||(r=m(this._remove,e,this.options))?r:this.defaultRule},forEach:function(e){for(var r=0;r<this.array.length;r++)e(this.array[r],r)}};function m(e,r,t){for(var n=0;n<e.length;n++){var i=e[n];if(K(i,r,t))return i}}function K(e,r,t){var n=e.filter;if(typeof n=="string"){if(n===r.nodeName.toLowerCase())return!0}else if(Array.isArray(n)){if(n.indexOf(r.nodeName.toLowerCase())>-1)return!0}else if(typeof n=="function"){if(n.call(e,r,t))return!0}else throw new TypeError("`filter` needs to be a string, array, or function")}function z(e){var r=e.element,t=e.isBlock,n=e.isVoid,i=e.isPre||function(U){return U.nodeName==="PRE"};if(!(!r.firstChild||i(r))){for(var a=null,o=!1,u=null,l=b(u,r,i);l!==r;){if(l.nodeType===3||l.nodeType===4){var f=l.data.replace(/[ \r\n\t]+/g," ");if((!a||/ $/.test(a.data))&&!o&&f[0]===" "&&(f=f.substr(1)),!f){l=g(l);continue}l.data=f,a=l}else if(l.nodeType===1)t(l)||l.nodeName==="BR"?(a&&(a.data=a.data.replace(/ $/,"")),a=null,o=!1):n(l)||i(l)?(a=null,o=!0):a&&(o=!1);else{l=g(l);continue}var d=b(u,l,i);u=l,l=d}a&&(a.data=a.data.replace(/ $/,""),a.data||g(a))}}function g(e){var r=e.nextSibling||e.parentNode;return e.parentNode.removeChild(e),r}function b(e,r,t){return e&&e.parentNode===r||t(r)?r.nextSibling||r.parentNode:r.firstChild||r.nextSibling||r.parentNode}var E=typeof window<"u"?window:{};function q(){var e=E.DOMParser,r=!1;try{new e().parseFromString("","text/html")&&(r=!0)}catch{}return r}function Q(){var e=function(){};return J()?e.prototype.parseFromString=function(r){var t=new window.ActiveXObject("htmlfile");return t.designMode="on",t.open(),t.write(r),t.close(),t}:e.prototype.parseFromString=function(r){var t=document.implementation.createHTMLDocument("");return t.open(),t.write(r),t.close(),t},e}function J(){var e=!1;try{document.implementation.createHTMLDocument("").open()}catch{E.ActiveXObject&&(e=!0)}return e}var Z=q()?E.DOMParser:Q();function ee(e,r){var t;if(typeof e=="string"){var n=re().parseFromString('<x-turndown id="turndown-root">'+e+"</x-turndown>","text/html");t=n.getElementById("turndown-root")}else t=e.cloneNode(!0);return z({element:t,isBlock:T,isVoid:B,isPre:r.preformattedCode?te:null}),t}var v;function re(){return v=v||new Z,v}function te(e){return e.nodeName==="PRE"||e.nodeName==="CODE"}function ne(e,r){return e.isBlock=T(e),e.isCode=e.nodeName==="CODE"||e.parentNode.isCode,e.isBlank=ie(e),e.flankingWhitespace=ae(e,r),e}function ie(e){return!B(e)&&!G(e)&&/^\s*$/i.test(e.textContent)&&!j(e)&&!X(e)}function ae(e,r){if(e.isBlock||r.preformattedCode&&e.isCode)return{leading:"",trailing:""};var t=le(e.textContent);return t.leadingAscii&&R("left",e,r)&&(t.leading=t.leadingNonAscii),t.trailingAscii&&R("right",e,r)&&(t.trailing=t.trailingNonAscii),{leading:t.leading,trailing:t.trailing}}function le(e){var r=e.match(/^(([ \t\r\n]*)(\s*))(?:(?=\S)[\s\S]*\S)?((\s*?)([ \t\r\n]*))$/);return{leading:r[1],leadingAscii:r[2],leadingNonAscii:r[3],trailing:r[4],trailingNonAscii:r[5],trailingAscii:r[6]}}function R(e,r,t){var n,i,a;return e==="left"?(n=r.previousSibling,i=/ $/):(n=r.nextSibling,i=/^ /),n&&(n.nodeType===3?a=i.test(n.nodeValue):t.preformattedCode&&n.nodeName==="CODE"?a=!1:n.nodeType===1&&!T(n)&&(a=i.test(n.textContent))),a}var oe=Array.prototype.reduce;function c(e){if(!(this instanceof c))return new c(e);var r={rules:s,headingStyle:"setext",hr:"* * *",bulletListMarker:"*",codeBlockStyle:"indented",fence:"```",emDelimiter:"_",strongDelimiter:"**",linkStyle:"inlined",linkReferenceStyle:"full",br:"  ",preformattedCode:!1,blankReplacement:function(t,n){return n.isBlock?`

`:""},keepReplacement:function(t,n){return n.isBlock?`

`+n.outerHTML+`

`:n.outerHTML},defaultReplacement:function(t,n){return n.isBlock?`

`+t+`

`:t}};this.options=W({},r,e),this.rules=new I(this.options)}c.prototype={turndown:function(e){if(!fe(e))throw new TypeError(e+" is not a string, or an element/document/fragment node.");if(e==="")return"";var r=M.call(this,new ee(e,this.options));return se.call(this,r)},use:function(e){if(Array.isArray(e))for(var r=0;r<e.length;r++)this.use(e[r]);else if(typeof e=="function")e(this);else throw new TypeError("plugin must be a Function or an Array of Functions");return this},addRule:function(e,r){return this.rules.add(e,r),this},keep:function(e){return this.rules.keep(e),this},remove:function(e){return this.rules.remove(e),this},escape:function(e){return P(e)}};function M(e){var r=this;return oe.call(e.childNodes,function(t,n){n=new ne(n,r.options);var i="";return n.nodeType===3?i=n.isCode?n.nodeValue:r.escape(n.nodeValue):n.nodeType===1&&(i=ue.call(r,n)),H(t,i)},"")}function se(e){var r=this;return this.rules.forEach(function(t){typeof t.append=="function"&&(e=H(e,t.append(r.options)))}),e.replace(/^[\t\r\n]+/,"").replace(/[\t\r\n\s]+$/,"")}function ue(e){var r=this.rules.forNode(e),t=M.call(this,e),n=e.flankingWhitespace;return(n.leading||n.trailing)&&(t=t.trim()),n.leading+r.replacement(t,e,this.options)+n.trailing}function H(e,r){var t=S(e),n=w(r),i=Math.max(e.length-t.length,r.length-n.length),a=`

`.substring(0,i);return t+a+n}function fe(e){return e!=null&&(typeof e=="string"||e.nodeType&&(e.nodeType===1||e.nodeType===9||e.nodeType===11))}var F=/highlight-(?:text|source)-([a-z0-9]+)/;function ce(e){e.addRule("highlightedCodeBlock",{filter:function(r){var t=r.firstChild;return r.nodeName==="DIV"&&F.test(r.className)&&t&&t.nodeName==="PRE"},replacement:function(r,t,n){var i=t.className||"",a=(i.match(F)||[null,""])[1];return`

`+n.fence+a+`
`+t.firstChild.textContent+`
`+n.fence+`

`}})}function he(e){e.addRule("strikethrough",{filter:["del","s","strike"],replacement:function(r){return"~"+r+"~"}})}var de=Array.prototype.indexOf,pe=Array.prototype.every,h={};h.tableCell={filter:["th","td"],replacement:function(e,r){return $(e,r)}};h.tableRow={filter:"tr",replacement:function(e,r){var t="",n={left:":--",right:"--:",center:":-:"};if(C(r))for(var i=0;i<r.childNodes.length;i++){var a="---",o=(r.childNodes[i].getAttribute("align")||"").toLowerCase();o&&(a=n[o]||a),t+=$(a,r.childNodes[i])}return`
`+e+(t?`
`+t:"")}};h.table={filter:function(e){return e.nodeName==="TABLE"&&C(e.rows[0])},replacement:function(e){return e=e.replace(`

`,`
`),`

`+e+`

`}};h.tableSection={filter:["thead","tbody","tfoot"],replacement:function(e){return e}};function C(e){var r=e.parentNode;return r.nodeName==="THEAD"||r.firstChild===e&&(r.nodeName==="TABLE"||me(r))&&pe.call(e.childNodes,function(t){return t.nodeName==="TH"})}function me(e){var r=e.previousSibling;return e.nodeName==="TBODY"&&(!r||r.nodeName==="THEAD"&&/^\s*$/i.test(r.textContent))}function $(e,r){var t=de.call(r.parentNode.childNodes,r),n=" ";return t===0&&(n="| "),n+e+" |"}function ge(e){e.keep(function(t){return t.nodeName==="TABLE"&&!C(t.rows[0])});for(var r in h)e.addRule(r,h[r])}function ve(e){e.addRule("taskListItems",{filter:function(r){return r.type==="checkbox"&&r.parentNode.nodeName==="LI"},replacement:function(r,t){return(t.checked?"[x]":"[ ]")+" "}})}function V(e){e.use([ce,he,ge,ve])}globalThis.createTurndownService=e=>{let r=new c(e??{});return r.use(V),r};globalThis.TurndownService=c;})();
