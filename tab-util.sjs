/*
  StratifiedJS facilities for communicating between background page
  and browser tabs in a chrome extension.

  requires oni-apollo >= 0.11.1
*/

//----------------------------------------------------------------------
// set this to console.log or something else to get debug information:

exports.log = function() {};

function log(x) { exports.log('tab-util.sjs: '+x); }

//----------------------------------------------------------------------
// eval a piece of JS code in tab and return result

var continuation_counter = Math.round(Math.random()*1e7);
var continuations = {};

function evalInTab(tabid, code) {
  code = code.replace(/'/g, "\\'");
  waitfor (var rv) {
    var c = continuation_counter++;
    continuations[c] = resume;
    var src = "(function() {try { var rv = eval('"+code+"');"+
      "if (rv) rv = rv.toString();"+
      "chrome.extension.sendRequest({id:"+c+", result:rv});"+
    "}catch(e) { chrome.extension.sendRequest({id:"+c+",error:e.toString()}) } })()";
    chrome.tabs.executeScript(tabid, {code:src});
  }
  finally {
    delete continuations[c];
  }
  if (rv.error) throw rv.error;
  return rv.result;
}

exports.evalInTab = evalInTab;

//----------------------------------------------------------------------
// eval a piece of SJS code in tab and return result

function $evalInTab(tabid, code) {
  code = code.replace(/'/g, "\\'").replace(/\n/g, "\\n");
  inject_sjs_crt(tabid);
  waitfor (var rv) {
    var c = continuation_counter++;
    continuations[c] = resume;
    var src = "chrome.extension.__$eval_from_remote("+c+",'"+code+"');";
    chrome.tabs.executeScript(tabid, {code:src});
  }
  retract {
    var src = "chrome.extension.__abort_from_remote("+c+");";
    chrome.tabs.executeScript(tabid, {code:src});
  }
  finally {
    delete continuations[c];
  }
  if (rv.error) throw rv.error;
  return rv.result;
}

exports.$evalInTab = $evalInTab;

//----------------------------------------------------------------------
// API that we expose to content scripts:

var api = {};
exports.api = api;

//----------------------------------------------------------------------
// set up request handler:

chrome.extension.onRequest.addListener(function(req, sender, send_resp) {
  try {
    if (req.id && continuations[req.id]) {
      var c = continuations[req.id];
      c(req, sender);
    }
    else if (req.method && api[req.method]) {
      send_resp({result:api[req.method].apply(null, req.args)});
      return;
    }
    else {
      throw "unexpected message";
    }
    send_resp({result:"ok"});
  }
  catch (e) {
    log('Error: '+e);
    try { send_resp({error:e.toString()}); } catch(e) {}
  }
});

//----------------------------------------------------------------------
// helper: injects sjs contentscript runtime (crt) into a tab:

// first a couple of tunneling methods to allow sjs to work normally
// from content scripts:
// load src from crx repo:
api.__crx_loader = function(path) {
  [,path] = /crx:(.*)/.exec(path);
  return __oni_rt.default_loader(path);
};
// jsonp tunneling:
api.__jsonp = require('__builtin:__sys').jsonp;


function inject_sjs_crt(tabid) {
  try {
    if (evalInTab(tabid, "window.$eval"))
      return; // already injected
  }
  catch(e) {}

  // our 'crt' is a patched up version of the oni apollo lib:
  var src = require('apollo:http').get(window.require.APOLLO_LOAD_PATH+"oni-apollo.js");
  
  // this line is to prevent us from loading any <script
  // type="text/sjs"> tags that might be on the page:
  src = "window.__oni_rt_no_script_load=true;"+src;
  
  // install a 'chrome.extension.apicall' method to make an api call:
  src += "
chrome.extension.apicall=window.$eval('(function(method, args){\
  waitfor(var rv){\
    chrome.extension.sendRequest({method:method, args:args},resume);\
  }\
  if (rv.error) throw rv.error;\
  return rv.result;\
})');
";
  
  // ...and 'chrome.extension.api.*' shorthands for all the methods we
  // expose:
  src += "chrome.extension.api = {};";
  for (var m in api)
    src +="chrome.extension.api."+m+"=function(){return chrome.extension.apicall('"+m+"', Array.prototype.slice.call(arguments,0))};";

  // this is to enable loading of modules from our crx repository...
  src = "window.__oni_rt_require_base='crx:';"+src;
  // ... using the 'crx_loader' api call:
  src += "require.hubs.push(['crx:', chrome.extension.api.__crx_loader]);";

  // finally, support for $eval'ing from remote:
  src += "
chrome.extension.__pending_remote_calls = {};
chrome.extension.__$eval_from_remote=window.$eval('(function(id,code){\
  waitfor {\
    try{\
      var rv=$eval(code);\
      if (rv) rv = rv.toString();\
      chrome.extension.sendRequest({id:id,result:rv});\
    }\
    catch(e){\
      chrome.extension.sendRequest({id:id,error:e.toString()})\
    }\
  }\
  or {\
    waitfor() {\
      chrome.extension.__pending_remote_calls[id] = resume;\
    }\
    finally {\
      delete chrome.extension.__pending_remote_calls[id];\
    }\
  }\
})');
chrome.extension.__abort_from_remote = function(id) {
  var abort = chrome.extension.__pending_remote_calls[id];
  if (abort) abort();
};
";

  // bootstrap part I
  waitfor(var x) {
    chrome.tabs.executeScript(tabid, {code:src}, resume);
  }

  // bootstrap part II
  // patch up apollo-sys-xbrowser to get jsonp to work:
  $evalInTab(tabid, "
require('__builtin:__sys').jsonp = chrome.extension.api.__jsonp;
");
}
