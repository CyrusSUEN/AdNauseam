//"use strict";

dump("\n[AN] Loading adNauseum.js (1)");

const Ci = Components.interfaces, Cc = Components.classes; // deprecated?
const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const prefs = Cc["@mozilla.org/preferences-service;1"].getService(Ci.nsIPrefBranch)
	.QueryInterface(Ci.nsIPrefBranch2);

Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/AddonManager.jsm");

const DEBUG = false;


AddonManager.addAddonListener({
	onUninstalling : function(addon) {
		dump("\n [AN] Uninstalling!");
		Services.prefs.setBoolPref("extensions.adnauseum.firstrundone", false);
	}
});


let AdVisitor =
{
	busy : false,
	initd : false,
    qsize : 100,
    checkMs : 5000,
    activity : 0,
	queue : [],
	tosnap : [], // ?
	snapped : [],
	visited : [],	
	logFile : null,
	ostream : null,
	activity : +new Date(),
    
	init: function() {
		
		//dump("\n[AV] AdVisitor.init()");
		
		try {

			this.hdomWindow = Cc["@mozilla.org/appshell/appShellService;1"]
				.getService(Ci.nsIAppShellService).hiddenDOMWindow;

			this.mainWindow = Cc['@mozilla.org/appshell/window-mediator;1']
				.getService(Ci.nsIWindowMediator).getMostRecentWindow('navigator:browser');
				
			this.component = Cc['@rednoise.org/adnauseum;1'].getService().wrappedJSObject;
			
			this.intervalId = this.mainWindow.setInterval // start checker
				(function(v) { v.checker(); }, this.checkMs, this); 
				
			this.log("AdVisitor.Enabled: "+this.getPref("extensions.adnauseum.enabled"));
			
			this.initd = true;
		}
		catch (e) {
			this.err("Failed on init: "+e);
		}
	},

	shutdown : function() {
                
		//this.dumpQ(this.history, "History");
		this.dumpQ(this.visited, "Visited");
		//this.dumpQ(this.tosnap, "toCapture");
		this.dumpQ(this.snapped, "Captured");
        
		if (1) { // delete snap dir?
			
			var file = Cc["@mozilla.org/file/directory_service;1"].getService
				(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
			// TODO: use preference here??
			file.append("adsnaps");
			if (file.exists) {
				try {
					file.remove(true);
					this.log("Removed: "+file.path);
				}
				catch(e) {
					this.warn("Removing: "+file.path+"\n"+e);
				}
			}	
		}
		
		this.log("Shutdown complete.\n");
		        
        if (this.ostream) this.ostream.close();	
    },
    
    getCaptureDir : function() { 
    	
    	var file = null;
		try {

			file = Cc["@mozilla.org/file/directory_service;1"].getService
				(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
			
			// TODO: use preference here??
			
			file.append("adsnaps");
			
			if (!file.exists()) {

				file.create(file.DIRECTORY_TYPE, 0775);
			}
		}	
		catch(e) {

			this.warn(this.snapdir + " not removed!\n" + e);
		}

		return file;
    },
	
    add : function(url) {
    	
		if (!this.initd) this.init();

		if (this.visited.indexOf(url) >= 0) {
			this.log("Ignoring (already-visited) :: "+url);
			return;
		}
		
		this.log("Queing("+(this.queue.length+1)+") :: "+url);
			
		this.queue.push(url);

        if (!this.busy) this.next(); // needed?
    },
    
    next : function() {

		this.activity = this.ms();
		
        if (this.queue.length) {
        	        	
			this.busy = true;
			
			var theNext = this.queue.pop();
			
			this.log();
			this.log("Ad-Click! :: "+theNext);

			this.fetchInHidden(theNext);
        }
        else {
        	this.busy = false;
        	this.log("Queue-empty :: #visited=" + this.visited.length+"  #captured="+ this.snapped.length
        		+ " elapsed="+((this.ms() - this.activity)/1000)+"s\n");
        		// + " tosnap=" + this.tosnap.length 
        }
    },
    
    fetchInTab : function(url) { // not used

    	var AdVisitor = this, gBrowser = this.mainWindow.gBrowser, tab = gBrowser.addTab(url);
    	tab.setAttribute("NOAD", true);
    	
    	gBrowser.addEventListener("DOMContentLoaded", function (e) {
			AdVisitor.afterLoad(e);
    	});
    	
		gBrowser.addEventListener("load", function (e) {
			AdVisitor.loadComplete(e);
    	});
    },
    
    fetchInHidden : function(url) {	
	
	    var doc = this.hdomWindow.document, AdVisitor = this,
	    	iframe = doc.getElementById("adn-iframe");

	    if (!iframe) {
	    	
	        iframe = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
	        iframe.wrappedJSObject = iframe;
	        
	        iframe.setAttribute("NOAD", "ADN");
	        iframe.setAttribute("id", "adn-iframe"); // need both of these? think so
	        
	        doc.documentElement.appendChild(iframe);
	        
	        iframe.addEventListener("DOMContentLoaded", function (e) {
	        	
	        	AdVisitor.afterLoad(e);
	        	
	        }, true);
	        
			iframe.onload = function(e){ AdVisitor.loadComplete(e); };
	        iframe.addEventListener('load', iframe.onload, true);	
	    }


		if (!url || /^https?:\/\/rednoise.org/.test(url)) {
			this.warn("Ignoring Url(null or app): "+url);
			return;	
		}
		
		if (!/^https?:\/\//.test(url)) {
			this.warn("Non-Http Url: "+url);
			return;	
		}
		
	    iframe.setAttribute("src", url);
    },
    
    beforeLoad : function(subject) {
    	
    	this.activity = this.ms();

		if (!this.initd) return;
		
	    var httpChannel = subject.QueryInterface(Ci.nsIHttpChannel), 
	    	url = httpChannel.URI.spec, origUrl = httpChannel.originalURI.spec;

    	(origUrl !== url) && (this.log("Redirect :: "
    		+origUrl+"\n               => "+url+" #waiting="+this.queue.length));
	    
	    var win = this.windowForRequest(subject); 
    	
    	var cHandler = win.QueryInterface(Ci.nsIInterfaceRequestor)
    		.getInterface(Ci.nsIWebNavigation).QueryInterface(Ci.nsIDocShell)
    		.chromeEventHandler;
    	
    	if (cHandler) {
    		
    		var kind = this.type(cHandler);
    		
    		if (kind === 'iframe' && cHandler.getAttribute("id") === 'adn-iframe') {
					    	
				if (this.snapped.indexOf(url) > -1) {
					this.log("Cancelled(exists) :: "+url);
					return this.cancelRequest(subject);
				}
	    	
				if (/(itunes\.apple|appstore)\.com/i.test(url))  {
	    			this.log("Cancelled(itunes) :: "+url);
					return this.cancelRequest(subject);
	    		}
	    		
	    		// WE LET THESE GO
	    			
	    		if (0 && !this.isResource(url))  {
	    			
	    			this.log("Preload :: " +url);
	    			
	    			// abort request if not capturing and they are images?
				} 
	    	}
    	    else {
    	    	
    	    	// USER REQUEST HERE... (is it from a tab?)

	    		//if (/browser/.test(kind) && !this.isResource(url)) 
					//this.log(kind+" -> "+url);

	    		/*var obj = cHandler.attributes;
	    		var s = ("\n"+cHandler+" ("+kind+")");
				for (var i = 0, len = obj.length; i < len; ++i)
	            	s += ("\n  "+obj[i].name+": "+obj[i].value);	            	
	           	dump(s+"\n"+this.line());*/
			}
    	}
    	else {
    		if (!this.isResource(origUrl)) {
	    		var msg = "BeforeLoad->No Handler :: "+origUrl;
	    		(origUrl !== url) && (msg += "\n                    "+url);
				this.log(msg);
			}
    	}
    },
    
    cancelRequest : function(subject) {
    	
    	this.activity = this.ms();
    	
    	try {
    		var request = subject.QueryInterface(Ci.nsIRequest);
	    	request && request.cancel(Components.results.NS_BINDING_ABORTED);
	    	return true;	
	    }
	    catch(e) {
	    	
	    	this.err(e);
	    }
	    return false;
    },
    
    afterLoad : function(e) {

		this.activity = this.ms();
		
		var doc = e.originalTarget, win = doc.defaultView, path = doc.location.href;
		
		if (path+'' === 'about:blank') return;	
			
		// Ignore XUL (?) 
		if (/.xul/.test(path)) {
			this.log("IGNORE :: "+path);
			doc.location.href = '';
			return;
		}
		
		// Ignore iTunes (?) 
		if (/(itunes\.apple|appstore)\.com/i.test(path)) {
			this.log("IGNORE (itunes) :: "+path);
			doc.location.href = '';
			return;
		}
		
		this.visited.push(path);
		
		if (0 && this.visited.length > this.qsize) { 
			this.visited.shift(); // TODO: re-add to fix log size? timeout-cache?
			dump("\nAdVisitor.visited removed: "+path); 
		}

		this.log("Visited :: "+path);

        /*if (this.snapped.indexOf(path) < 0) {
        	this.tosnap.length>0 && this.warn("snapQ=fuct!");
        	this.log("QueueSnap (tosnap.length="+(this.tosnap.length+1)+") :: "+path);
        	this.tosnap.push(path);
        }*/
       //this.nextSnap = path;
    },

    loadComplete : function(e) {
	
		this.activity = this.ms();
		
		var doc = e.originalTarget, win = doc.defaultView, path = doc.location.href;

		this.log("Complete :: "+path);

       	if (this.snapped.indexOf(path) < 0) {
    	
	    	this.log("Captured :: "+path+ " #waiting="+this.queue.length);
	
	    	var cHandler = win.QueryInterface(Ci.nsIInterfaceRequestor)
				.getInterface(Ci.nsIWebNavigation).QueryInterface(Ci.nsIDocShell)
				.chromeEventHandler, cwin = cHandler.contentWindow;
				
			if (cHandler && // this.is(cHandler, 'iframe') && 
				cHandler.getAttribute("id") === 'adn-iframe') 
			{
					var file = this.getSnapshot(doc, cwin);
					if (file) {
						this.log("  to "+file.path);
						
						// move from tosnap to snapped
						//this.tosnap.splice(idx, 1);
						this.snapped.push(path);
					}
					else {
						this.warn("Snapshot failed: "+path);
					}
	    	}
	    	else {
				this.log("AfterFullLoad->No Handler :: "+path);
	    	}
		}
		else {
			
			this.log("Snapshot exists: "+path+" queue="+this.queue.length);
		}
	
		// this.next();  TODO: ?? 
    },
    
   	getSnapshot : function(document, contentWindow) {
   		
   		var window = document.defaultView, canvas, x=0, y=0;
   		
		//this.log("getSnapshot("+window+", "+document+", "+contentWindow+");");

        var width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        var height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        
        try {
            canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "html:canvas");
            canvas.height = height;
            canvas.width = width;

            // maybe https://bugzil.la/729026#c10 ?
            var ctx = canvas.getContext("2d");
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            ctx.drawWindow(contentWindow, x, y, width, height, "rgb(255,255,255)");
        } 
        catch(err) {

            canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "html:canvas");
            var scale = Math.min(1, Math.min(8192 / height, 8192 / width));
            canvas.height = height * scale;
            canvas.width = width * scale;

            var ctx = canvas.getContext("2d");

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.scale(scale, scale);
            ctx.save();
            ctx.drawWindow(contentWindow, x, y, width, height, "rgb(255,255,255)");
        }
 
		return this.saveToDisk(window, canvas.toDataURL("image/png", ""));
  	},

    saveToDisk : function(window, data) {
    	    	
		//this.log("saveToDisk("+window+", data);");

    	var file, fileName = 'adn'+'_'+(new Date()).toISOString().replace(/:/g,'-')+'.png'
    	
		file = this.getCaptureDir();
  		file.append(fileName);

	    return file ? this.saveFile(file, data) : null;
    },
    
    saveFile : function(file, data) {
    	
    	//this.log("saveFile("+file.path+", data);");

    	try {
		    var ios = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
		    var source = ios.newURI(data, 'utf8', null);
		    var target = ios.newFileURI(file);
		
		    var persist = Cc['@mozilla.org/embedding/browser/nsWebBrowserPersist;1']
		    	.createInstance(Ci.nsIWebBrowserPersist);
		    persist.persistFlags = Ci.nsIWebBrowserPersist.PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION;
		
		    var transfer = Cc['@mozilla.org/transfer;1'].createInstance(Ci.nsITransfer);
		    transfer.init(source, target, '', null, null, null, persist, false);
		    persist.progressListener = transfer;
		
		    persist.saveURI(source, null, null, null, null, file, null);
	    }
	    catch (e) {
	    	this.log("SaveFile: "+e);
	    }
	    
	    return file;
    },
	
	// Utils ---------------------------------------------------------------------------
     
    dumpElement : function(ele) {
    	
    	if (!ele) return;
    	
    	var kind = this.type(ele);
		var obj = ele.attributes;
		
		var s = "ELEMENT: '"+kind+"'";
		for (var i = 0, len = obj ? obj.length : 0; i < len; ++i)
        	s += ("\n  "+obj[i].name+": "+obj[i].value);	
        
        var style = ele.style, styleStr='';
        
        if (style) {

			for (var i in style) {
				
				if (! (style[i] && style[i].length && typeof style[i] !== 'function') ) 
					continue;
					
			    // if it's not a number-index, print it out.
			    if (/^[\d]+/.exec(i) == null) {
			        styleStr += "\n    "+i+" = '"+style[i]+"'";
			    }
			}
        }
        
        if (styleStr.length) s += "\n  styles: " + styleStr;
	            	
       	this.log(s);
    },

	windowForRequest : function(request) {

		if ( request instanceof Ci.nsIRequest) {
			try {
				if (request.notificationCallbacks) {
					return request.notificationCallbacks.getInterface
						(Ci.nsILoadContext).associatedWindow;
				}
			} catch(e) {}

			try {
				if (request.loadGroup && request.loadGroup.notificationCallbacks) {
					return request.loadGroup.notificationCallbacks.getInterface
						(Ci.nsILoadContext).associatedWindow;
				}
			} catch(e) {}
		}

		return null;
	},
	
    tabForHttpChannel : function(domWindow) { // unused for now
    	
       	var tab, tIndex = -1, gBrowser = this.mainWindow.gBrowser;

        if (!gBrowser) {
        	this.log("no gBrowser");
        	return;
        }
                
        tIndex = gBrowser.getBrowserIndexForDocument(DOMWindow.document);
		
        // handle the case where there was
        if (tIndex > -1) {
            tab = gBrowser.tabContainer.childNodes[tIndex];
			this.log("Found tab: "+tab);
		}
		//else no tab associated with the request (rss, etc)
			
		return tab;
    },
    
    isResource : function(url) { return /\.(css|jpg|png|js|gif|swf|xml|ico|json)(\?|$|#)/i.test(url); },
    
    type : function(ele) {

    	if (typeof ele.tagName !== 'undefined') return ele.tagName;
    	if (typeof ele.nodeName !== 'undefined') return ele.nodeName;
    	return ele+"";	
    },
    
	is : function(ele, name) {
    	return ele && this.type(ele) === name;	
    },
    
	diff : function(s1, s2) { // set difference of 2 arrays
    
        var result = []; 
        for (var i=0,j=s1.length; i<j; i++) {
			if (s2.indexOf(s1[i]) < 0)
				result.push(s1[i]);
        }
        return result;
	},
	
	remove : function(arr, ele) { // arr.remove(ele)
    
		 var index = arr.indexOf(ele);
		 while (index > -1) {
		 	arr.splice(index, 1);
		 	index = arr.indexOf(ele);
		 }
		 return arr;
	},
	
	trimPath : function(u, max) {
		max = max || 60;
		if (u && u.length > max) 
			u = u.substring(0,max/2)+"..."+u.substring(u.length-max/2);
		return u;
	},
	
	ms : function() { return new Date().valueOf(); },
	
	getPref : function(x) { return this.component.getPref(x); },
	
	setPref : function(x,y) { return this.component.setPref(x,y); },
	
	checker : function() {
		
		var now = this.ms();

		if ((now - this.activity) > (this.checkMs*2)) {
			
			if (this.queue.length) { // only log if we have a queue
				
				this.log("Status :: #captures="+this.snapped.length+" #waiting="
					+this.queue.length+" elapsed="+((now - this.activity)/1000)+"s");
			}
			this.next();
		}
	},
		
	dumpQ : function(queue, label) {
		
    	var s = label+"("+queue.length+"):\n";
        for (var i=0; i < queue.length; i++)
          s += "  "+(i+1)+") "+this.trimPath(queue[i]) +"\n";
        this.log(s);
	},
	
	line : function(num, sep) {
		var s = '';
		num = num || 50;
		sep = sep || '=';
		for (var i=0; i < num; i++) 
		  s += sep;
		return s+'\n';
	},

	logAll : function(obj) { // not used

        dump("\n"+this.line());
		this.logO(obj);
		var atts = obj.attributes;
		var s= "\n"+this.line();
		s += "\nAtts: "+obj+" ("+this.type(obj)+")";
		for (var i = 0, len = atts.length; i < len; ++i)
        	s += "\n  "+atts[i].name+": "+atts[i].value;
       	dump(s+"\n"+this.line());
 	},	

	logO : function(object,label) { // not used
		
		label = label || this.type(object);
		var stuff = [];
		for (s in object) {
			stuff.push(s);
		}
		stuff.sort();
		dump("\n"+label + ': ' + stuff);
	},
   
   	warn : function(msg, dumpit) { 
   		
   		this.log("[WARN]\n     "+msg, dumpit);
   	},
   	
   	err : function(msg) { 
   		
   		this.log("[ERROR]" + this.line(90) + msg + "\n");
   	},
   	
	resetLog : function() { 
		
		this.log("Log(clear) :: " + this.logFile.path);

		if (this.logFile && this.logFile.exists()) {

			try {
				this.logFile.remove(false);
				this.ostream = null;
				this.initLog();	
			} 
			catch(e) {
				dump("\n\n[ERROR] " + e);
				return;
			}
		}
   	},
   	
    initLog : function() {
    	 
		dump("\n[AV] Initializing Log");

		try {

			this.logFile = Cc["@mozilla.org/file/directory_service;1"]
				.getService(Ci.nsIProperties).get("ProfD", Ci.nsIFile);
				
			this.logFile.append("adnauseum.log");

			if (!this.logFile.exists()) {

				this.logFile.create(Ci.nsIFile.NORMAL_FILE_TYPE, 0666);
				dump("\n[AV] Created " + this.logFile.path);
			}
	
			if (!this.ostream) {
				
				this.ostream = Cc["@mozilla.org/network/file-output-stream;1"]
						.createInstance(Ci.nsIFileOutputStream);
				this.ostream.init(this.logFile, -1, -1, 0); // truncate
				this.log("Log: " + this.logFile.path);			
			}
		}
		catch(e) {
			
			dump("\n\n[ERROR] " + e);
			return;
		}
	},
		

	log : function(msg, dumpit) { // dumpit: [0=log-only -1=dump-only 1=both]

		dumpit = dumpit || 1;
		
		if (typeof this.ostream === 'undefined' || !this.ostream) this.initLog();

		if (DEBUG && dumpit) dump("\n[AV] "+this.trimPath(msg) + "\n"); 
		
		if (dumpit != -1) {
			
			if (!msg || !msg.length) {
				msg = "\r\n";
				this.ostream.write(msg, msg.length);
				return;
			}
			
			var d = new Date(), ms = d.getMilliseconds()+'', now = d.toLocaleTimeString();
		    ms =  (ms.length < 3) ? ("000"+ms).slice(-3) : ms;
	 
			msg = "[" + now  + ":" + ms + "] " + msg + "\n" + this.line(90);
				
			if ( typeof this.ostream === 'undefined' || !this.ostream) {
				dump("\n\n[ERROR] NO IO!");
				return;
			}
			
			this.ostream.write(msg, msg.length);
		}
	}  
};

////////////////////////////////////////////////////////////////////////////////////////////////

////////////////////////////////////////////////////////////////////////////////////////////////


// class constructor
function AdNauseumComponent() {
	
    this.wrappedJSObject = this;
}

// class definition
AdNauseumComponent.prototype = {
	
    // properties required for XPCOM registration: 
    classID : Components.ID("{741b4765-dbc0-c44e-9682-a3182f8fa1cc}"),
    contractID : "@rednoise.org/adnauseum;1",
    classDescription : "AdNauseum Core Component",

    QueryInterface : XPCOMUtils.generateQI([ Ci.nsIObserver ]), 

    // add to category manager
    _xpcom_categories : [ { category : "profile-after-change" } ],

    init : function() {
      
        let result = {};
        result.wrappedJSObject = result;
        Services.obs.notifyObservers(result, "adblockplus-require", 'contentPolicy');

        this.policy = result.exports.Policy;
        
        if (!this.policy) {
        	dump("\n[FATAL] No Policy")
            return false;
		}
        
        if (!this.policy.processNode) {
        	dump("\n[FATAL] No Policy.processNode")
        	return false;
        }
        
        // this should be in the 'enabled' observer?
        this.policy.oldprocessNode = this.policy.processNode;
        this.policy.processNode = this.processNodeABP;

        this.setPref("extensions.adblockplus.fastcollapse", false);
        
        this.visitor = AdVisitor;
        
		this.visitor.log("State: enabled=" + this.getPref("extensions.adnauseum.enabled")
			+ ", highlights=" + this.getPref("extensions.adnauseum.highlightads")
			+ ", capturing=" + this.getPref("extensions.adnauseum.savecaptures"));
        
        return true;
    },
    
    // nsIObserver interface implementation
    observe : function(aSubject, aTopic, aData) {
    	
        var observerService = Cc["@mozilla.org/observer-service;1"].getService(Ci.nsIObserverService);

        switch (aTopic) {
	        
	        case "profile-after-change":
	        
	            // Doing init stuff on FireFox start
	            observerService.addObserver(this, "http-on-modify-request", false);
	            observerService.addObserver(this, "quit-application", false);
	            
	            this.init();
	            
	            break;
	            
			case "quit-application":

	            // Doing shutdown stuff on FireFox quit
	            observerService.removeObserver(this, "quit-application");
	            observerService.removeObserver(this, "http-on-modify-request");

	            this.visitor.shutdown();
	            
	            dump("\n[AN] AdNauseumComponent.shutdown()");
	            
	            break;
	            
	        case "http-on-modify-request":
	        
				// Called before each Http request 

	        	this.visitor.beforeLoad(aSubject);
	        	
	        	break;
		}
    },
    
	clearLog : function() {
		
		this.visitor.resetLog();
   	},

	processNodeABP : function(wnd, node, contentType, location, collapse) {

		// NOTE: this will be run in context of AdBlockPlus
		var adn = Cc['@rednoise.org/adnauseum;1'].getService().wrappedJSObject;
    		
	    var enabled = adn.getPref("extensions.adnauseum.enabled"); 
	   	if (!enabled) return true;

		return adn.processNodeADN(wnd, node, contentType, location, collapse) ;
        		  
    	// : this.policy.oldprocessNode(wnd, node, contentType, location, collapse); 
    },
    
    processNodeADN : function(wnd, node, contentType, location, collapse) {

        if (!this.policy || /^chrome:\//i.test(location)) return true;

        if (!node || !node.ownerDocument || !node.tagName) {
        	
            return (this.getPref("extensions.add-art.enableMoreAds")) ? 
            	true :  this.policy.oldprocessNode(wnd, node, contentType, location, collapse);
        }       
        
        if (node.hasAttribute("NOAD")) { 
        	
        	// dump("\n\nSkipping NOAD: "+node.getAttribute("NOAD"));
        	return true;
        }
            
        if (contentType == Ci.nsIContentPolicy.TYPE_STYLESHEET ||
                contentType == Ci.nsIContentPolicy.TYPE_DOCUMENT ||
                contentType > Ci.nsIContentPolicy.TYPE_SUBDOCUMENT   )
            return this.policy.oldprocessNode(wnd, node, contentType, location, collapse);
            
        var html0 = node.ownerDocument.getElementsByTagName('HTML')[0]
        if (contentType == Ci.nsIContentPolicy.TYPE_SCRIPT && html0 
        	&& html0.getAttribute('inAdScript') == 'true') 
        {
            
            // Here possible should be done some work with script-based ads
            return true;
        } 
        else {
        	
            if (this.policy.oldprocessNode(wnd, node, contentType, location, collapse) == 1)
                return true;
                
            if (contentType == Ci.nsIContentPolicy.TYPE_SCRIPT) {
                //Here possible should be done some work with script-based ads 
                return true;
            }
        }

        try {
        	
            // Replacing Ad Node to Node with Art
            var RNode = this.findAdNode(node,contentType);
            
            if (this.checkDanger(RNode))  {
            	return this.policy.oldprocessNode(wnd, node, contentType, location, collapse);
            }


            if (RNode.parentNode) {
            	
                var newNode = this.transform(RNode, wnd);
                if (newNode) {
                    RNode.parentNode.replaceChild(newNode, RNode);  
                }
                else {
                    return this.policy.oldprocessNode(wnd, node, contentType, location, collapse);
                }
                
            }

        } 
        catch(e) {
            this.visitor.err("Error in: " + e.fileName +", line number: " + e.lineNumber +", " + e);
        }

        return false;
    },

    findAdNode : function(node, contentType) {

        var adNode = node;

        while (adNode.parentNode && (
        	adNode.parentNode.tagName == 'A' ||
			adNode.parentNode.tagName == 'OBJECT' ||
            adNode.parentNode.tagName == 'IFRAME' ||
            (adNode.hasAttribute && adNode.hasAttribute('onclick')))) 
		{    
            adNode = adNode.parentNode;
        }
            
        return adNode;
    },
    
    loadImgArray : function() {
    	
    	this.visitor.log("loadImgArray");
    	
        this.ImgArray = [];
        
        // taken from: https://en.wikipedia.org/wiki/Web_banner
        // 19 images sizes total

        // Rectangles
        this.ImgArray.push( [ 336, 280 ] ); // Large Rectangle
        this.ImgArray.push( [ 300, 250 ] ); // Medium Rectangle
        this.ImgArray.push( [ 180, 150 ] ); // Rectangle
        this.ImgArray.push( [ 300, 100 ] ); // 3:1 Rectangle
        this.ImgArray.push( [ 240, 400 ] ); // Vertical Rectangle

        // Squares
        this.ImgArray.push( [ 250, 250 ] ); // Square Pop-up

        // Banners
        this.ImgArray.push( [ 720, 300, ] ); // Pop-Under
        this.ImgArray.push( [ 728, 90, ] ); // Leaderboard
        this.ImgArray.push( [ 468, 60, ] ); // Full Banner
        this.ImgArray.push( [ 234, 60, ] ); // Half Banner
        this.ImgArray.push( [ 120, 240 ] ); // Vertical Banner

        //Buttons
        this.ImgArray.push( [ 120, 90 ] ); // Button 1
        this.ImgArray.push( [ 120, 60 ] ); // Button 2
        this.ImgArray.push( [ 88, 31 ] ); // Micro Bar
        this.ImgArray.push( [ 88, 15 ] ); // Micro Button
        this.ImgArray.push( [ 125, 125 ] ); // Square Button

        //Skyscrapers
        this.ImgArray.push( [ 120, 600 ] ); // Standard Skyscraper
        this.ImgArray.push( [ 160, 600 ] ); // Wide Skyscraper
        this.ImgArray.push( [ 300, 600 ] ); // Half-Page

    },

    askLink : function(width, height) {
    	
        // Find this.ImgArray with minimal waste (or need - in this case it will be shown in full while mouse over it) of space
        
        if (!this.ImgArray) this.loadImgArray();

        var optimalbanners = null;
        var minDiff = Number.POSITIVE_INFINITY;
        for ( var i = 0; i < this.ImgArray.length; i++) {
            var diff = Math.abs(width / height - this.ImgArray[i][0] / this.ImgArray[i][1]);
            if (Math.abs(diff) < Math.abs(minDiff)) {
                minDiff = diff;
                optimalbanners = [ i ];
            } else if (diff == minDiff) {
                optimalbanners.push(i);
            }
        }

        var optimalBanner = [];
        minDiff = Number.POSITIVE_INFINITY;
        for (i = 0; i < optimalbanners.length; i++) {
            var diff = Math.abs(width * height - this.ImgArray[optimalbanners[i]][0] * this.ImgArray[optimalbanners[i]][1]);
            if (diff < minDiff) {
                minDiff = diff;
                optimalBanner = [ optimalbanners[i] ];
            } else if (diff == minDiff) {
                optimalBanner.push(optimalbanners[i]);
            }
        }
        return this.ImgArray[optimalBanner[Math.floor(Math.random() * optimalBanner.length)]];
    },
    
    checkDanger: function(element) {
    	
        // if we try to replace elements of this kind, firefox crashes.
        return typeof (element.wrappedJSObject) == 'function';
    },

    
    typeofSize : function(Str_size) {
        
        if (Str_size === "auto")
            return "auto";
            
        if (Str_size === "inherit")
            return "inherit";
            
        if (Str_size.indexOf && Str_size.indexOf('%') > -1)
            return "percentage";
            
        return "pixel";
    },

    getSize : function(prop, elt) {
    	

		var wnd=null, compW=null, parentcompW=null;

		if (elt.ownerDocument) {
			if (elt.ownerDocument.defaultView && elt.ownerDocument.defaultView.getComputedStyle(elt, null)) {
				wnd = elt.ownerDocument.defaultView;
				compW = wnd.getComputedStyle(elt, null).getPropertyValue(prop);

				if (elt.parentNode) {
					parentcompW = wnd.getComputedStyle(elt.parentNode, null).getPropertyValue(prop);
				}
			}
		}

		if (!compW) {
			if (elt.style[prop])
				compW = elt.style[prop];
			else if (elt[prop])
				compW = elt[prop];
			else
				compW = 0;
		}

		var capital_name = {'width':'Width', 'height':'Height'}[prop];

		if (wnd && elt.tagName == 'A') {
			var size = 0;
			for (var i = 0; i < elt.childNodes.length; i++) {
				var child = elt.childNodes[i];
				if (child.nodeType == 1) {
					size = Math.max(size, parseInt(wnd.getComputedStyle(child, null).getPropertyValue(prop)));
				}
			};
			return size;
		}

		var x;
		if (this.typeofSize(compW) == "percentage") {
			if (this.typeofSize(parentcompW) !== "pixel")
				x = 0;
			else
				x = parseInt(parseInt(compW) * parseInt(parentcompW) / 100);
		} else if (this.typeofSize(compW) == "auto") {
			
			x = elt['offset' + capital_name];
		}
		else if (this.typeofSize(compW) == "inherit") {
			if (this.typeofSize(parentcompW) !== "pixel") 
				x = 0;
			else
				x = parseInt(parentcompW);
		} else {
			x = parseInt(compW);
		}

		return x;

    },

    transform : function(ToReplace, wnd) {
    	
    	// Ignore small ads...
        try {
            var theH = this.getSize("height", ToReplace), theW = this.getSize("width", ToReplace);

            if (theH < 10 || theW < 10) {
            	
				var toClick='unknown', ele = ToReplace.wrappedJSObject;
		        if (ele && ele.tagName === 'A') 
		        	toClick = ele.getAttribute("href");
            	
            	//this.visitor.log("Ignore-small :: "+toClick);
            	
            	return null;
            }

	        var placeholder = ToReplace.ownerDocument.createElement("div");
	
	        if (theW == 0 || theH == 0) {  // WHAT IS THIS DOING?
	        	
	        	this.visitor.warn("Creating place-holder div");
	        	
	            placeholder = ToReplace.ownerDocument.createElement("div");
	            placeholder.setAttribute("NOAD", "true");
	            
	            if (ToReplace.hasAttribute("style"))
	                placeholder.setAttribute("style", ToReplace.getAttribute("style"));
	            if (placeholder.style.background)
	                placeholder.style.background = "";
	                
	            var Nodes = ToReplace.childNodes;
	            for ( var i = 0; i < Nodes.length; i++) {
	                if (Nodes[i].nodeType == Ci.nsIContentPolicy.TYPE_OTHER)
	                    placeholder.appendChild(this.transform(Nodes[i]));
	            }
	            
	            if (ToReplace.hasAttribute("id"))
	                placeholder.setAttribute("id", ToReplace.getAttribute("id"));
	            if (ToReplace.hasAttribute("name"))
	                placeholder.setAttribute("name", ToReplace.getAttribute("name"));
	            if (ToReplace.hasAttribute("class"))
	                placeholder.setAttribute("class", ToReplace.getAttribute("class"));
	            if (ToReplace.style.display == 'none')
	                placeholder.style.display = 'none';
	        } 
	        else {
	        	
	        	// normal case
	            placeholder = this.createConteneur(ToReplace, wnd, theH, theW);
	        }
        
        }
        catch(e) {
        	
            this.visitor.err(e.lineNumber + ', ' + e);
		}
 

        return placeholder;
    },
    
    getGBrowser : function() {

    	return this.visitor.mainWindow.gBrowser;
    },
    
    getPref : function(PrefName) {

		var Type = prefs.getPrefType(PrefName);
		if (Type == prefs.PREF_BOOL)
			return prefs.getBoolPref(PrefName);
		else if (Type == prefs.PREF_STRING)
			return prefs.getCharPref(PrefName);
		else if (Type == prefs.PREF_INT)
			return prefs.getIntPref(PrefName);
    },
    
    setPref: function(PrefName, prefValue) {
 
		if (this.getPref(PrefName) !== prefValue) {
			var Type = prefs.getPrefType(PrefName);
			if (Type == prefs.PREF_BOOL)
				prefs.setBoolPref(PrefName, prefValue);
			else if (Type == prefs.PREF_STRING)
				prefs.setCharPref(PrefName, prefValue);
			else if (Type == prefs.PREF_INT)
				prefs.setIntPref(PrefName, prefValue);
		}
    },
    
	log : function(s,t) { this.visitor.log(s,t); },

    createConteneur : function(OldElt, wnd, l, L) {

		//dump("\ncreateConteneur: "+OldElt);
            
        // This replaces Ad element to element with art
        var newElt = null, ele = OldElt.wrappedJSObject;
        
        if (!ele) dump("\n\n[ERROR] Null ELE: "+OldElt);

        var isA = ele.tagName == 'A';
        
        if (isA) {
        	
            var toClick = ele.getAttribute("href");
            
            this.visitor.add(toClick); // follow redirects DCH: **********
            
            ele.title = "Ad Nauseum: "+toClick.substring(0,40)+"...";
            ele.style.outline = '#D824B7 none medium'
            if (this.getPref("extensions.adnauseum.highlightads"))
            	ele.style.outline = '#D824B7 double medium';
        }
        
        //else dump("\n[AV] Ignoring: "+ele.tagName);

        return null; // Comment skip this if hiding ads with add-art
        
        if (this.checkDanger(OldElt)) return null;
        
        newElt = OldElt.ownerDocument.createElement("div"); 
        
        newElt.setAttribute("NOAD", "true");

        // Copying style from old to new element and doing some replacing of it 
        newElt.setAttribute("style", OldElt.getAttribute("style"));
        if (OldElt.ownerDocument.defaultView && OldElt.ownerDocument.defaultView.getComputedStyle(OldElt, null)) {
            EltStyle = OldElt.ownerDocument.defaultView.getComputedStyle(OldElt, null);
            newElt.style.position = EltStyle.getPropertyValue('position');
            if (EltStyle.getPropertyValue('display') == 'inline' || EltStyle.getPropertyValue('display') == 'inline-table')
                newElt.style.display = "inline-block";
            else
                newElt.style.display = EltStyle.getPropertyValue('display');
            newElt.style.visibility = EltStyle.getPropertyValue('visibility');
            newElt.style.zIndex = EltStyle.getPropertyValue('z-index');
            newElt.style.clip = EltStyle.getPropertyValue('clip');
            newElt.style.float = EltStyle.getPropertyValue('float');
            newElt.style.clear = EltStyle.getPropertyValue('clear');
        }
        

        newElt.style.background = "";
        if (OldElt.hasAttribute("id"))
            newElt.setAttribute("id", OldElt.getAttribute("id"));
        if (OldElt.hasAttribute("name"))
            newElt.setAttribute("name", OldElt.getAttribute("name"));
        if (OldElt.hasAttribute("class"))
            newElt.setAttribute("class", OldElt.getAttribute("class"));

        newElt.style.height = l + "px";
        newElt.style.width = L + "px";
        newElt.style.overflow = "hidden";
        newElt.style.cursor = "pointer";
        newElt.title = "Replaced by Add-Art";
        
        // Expanding images
        // Setting Art to be shown in full while is over it
        if (this.getPref("extensions.add-art.expandImages")) {
            newElt.setAttribute("onmouseover","this.style.overflow = 'visible';this.style.zIndex= 100000;");
            newElt.setAttribute("onmouseout","this.style.overflow = 'hidden';this.style.zIndex= 0;");
            newElt.setAttribute("onclick","window.top.location = 'http://add-art.org/';");  
        }

        var img = OldElt.ownerDocument.createElement("img");
        img.setAttribute("NOAD", "true");
        img.setAttribute("border", "0");
        var Img = this.askLink(L, l);
        
        // Select banner URL
        // use the URL in a top window to generate a number b/w 1 and 8 (to maintain some persistence)
        var win = Cc['@mozilla.org/appshell/window-mediator;1']
        	.getService(Ci.nsIWindowMediator)
        	.getMostRecentWindow('navigator:browser');
        	
        if (win != null) {
            var el = win.document.getElementById('content');
            if (el != null) {
                var loc = el.mCurrentBrowser.contentWindow.location.href;
            }
        }

        if (loc) {
            var randomImage8 = loc.charCodeAt( loc.length - 6 ) % 8 + 1;
        } else {
            var randomImage8 = Math.floor(Math.random()*8);
        }
        
        // pick the image
        var filename = randomImage8+"artbanner"+Img[0]+"x"+Img[1]+".jpg";
        var url = "chrome://addart/skin/"+filename;
        
        img.setAttribute("src", url);

        // return newElt;
        if (Img[1] * l / Img[2] < L) {
            img.style.width = L + "px";
            img.style.marginTop = parseInt((l - Img[1] * L / Img[0]) / 2) + 'px';
        } else {
            img.style.height = l + "px";
            img.style.marginLeft = parseInt((L - Img[0] * l / Img[1]) / 2) + 'px';
        }
        newElt.appendChild(img);
        
        return newElt;
    }
};

/**
 * XPCOMUtils.generateNSGetFactory was introduced in Mozilla 2 (Firefox 4,
 * SeaMonkey 2.1). XPCOMUtils.generateNSGetModule was introduced in Mozilla 1.9
 * (Firefox 3.0).
 */
if (XPCOMUtils.generateNSGetFactory)
    var NSGetFactory = XPCOMUtils.generateNSGetFactory( [ AdNauseumComponent ]);
else
    var NSGetModule = XPCOMUtils.generateNSGetModule( [ AdNauseumComponent ]);