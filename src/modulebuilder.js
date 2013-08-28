/*

	(The MIT License)

	Copyright (C) 2005-2013 Kai Davenport

	Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

	The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

 */

/*
  Module dependencies.
*/
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var util = require('util');
var path = require('path');
var _ = require('lodash');
var telegraft = require('telegraft');

var utils = require('digger-utils');
var Warehouse = require('digger-warehouse');
var Client = require('digger-client');
var Logger = require('./logger');

/*

	the generic bootloader for a part of the digger network

	we build a connection back onto a reception server
*/

function ModuleBuilder(application_root){
	var self = this;
	
	/*
	
		where is the hq running
		
	*/
	this.hq_endpoints = {
		server:'tcp://' + (process.env.DIGGER_HQ_HOST || '127.0.0.1') + ':' + (process.env.DIGGER_HQ_SERVER_PORT || 8791),
		radio:'tcp://' + (process.env.DIGGER_HQ_HOST || '127.0.0.1') + ':' + (process.env.DIGGER_HQ_RADIO_PORT || 8792)
	}

	this.application_root = application_root;

	// used for when we boot the whole stack inline
	this.next_port = 8793;

	this.logger = Logger();

	/*
	
		the only module we do not create a supplychain for is the telegraft hq
		
	*/
	if(this.type!='hq'){
		this.create_supplychain();
	}
}

util.inherits(ModuleBuilder, EventEmitter);

module.exports = ModuleBuilder;

ModuleBuilder.prototype.create_supplychain = function(type, config){
	var self = this;
	this.telegraft = telegraft.client(this.hq_endpoints);
	this.reception_socket = this.telegraft.rpcclient('/reception');

	/*
	
		the function via which we make requests to the reception server
		
	*/

	this.socket_pipe = function(req, reply){
		self.reception_socket.send(req, reply);
	}

	// a request that has come from the outside
	this.external_handler = function(req, reply){

		/*
		
			make double sure there are no other properties creeping in
			
		*/
		self.socket_pipe({
			method:req.method,
			url:req.url,
			headers:req.headers,
			body:req.body
		}, reply);

	}

	// a request that has originated from server side code
	this.internal_handler = function(req, reply){
		/*
		
			this is a very important flag

			it means that because we are running code on the server we are effectively
			the root user and so can do what we want to our own stack

			req.internal cannot ever be set by the outside because only:

				method
				headers
				url
				body

			are copied from external requests
			
		*/
		req.internal = true;
		self.socket_pipe(req, reply);
	}

	/*
	
		create the supplychain we will give to internal code

		we pipe requests via the internal handler which gives them privilaged access

		for external requests - we pipe from the app to external_handler (below)
		
	*/
	this.supplychain = Client(this.internal_handler);

	/*
	
		this is where a module might require a proxy directly onto anywhere in the network
		
		the reception uses this to route back to warehouse servers

		we are only returning the telegraft proxy which does the routing magic
		
	*/
	this.supplychain.get_proxy = function(){
		return self.telegraft.rpcproxy();
	}

	this.supplychain.get_logger = function(){
		return self.logger;
	}

	/*
	
		assign the radio so functions can do realtime
		
	*/
	this.supplychain.radio = this.telegraft.radio;

	/*
	
		mount a function on the network 

	*/
	var server = null;

	/*
	
		the http server we mount our apps onto

		this might not be created - only for front end web apps
		
	*/
	var www = null;

	/*
	
		the warehouse we store our routes in

		this lets us have multiple routes on one server
		
	*/
	var serverrunner = null;

	this.supplychain.mount_server = function(route, address, handler){

		if(arguments.length<=2){
			handler = address;
			address = null;
		}

		if(!handler){
			console.error('you need to pass a function to mount_server');
			process.exit();
		}

		/*
		
			the address can be passed up by the module (in the case it is binding multiple places)

			otherwise we create it - either from the environment or defaults which increments the port each time
			
		*/
		if(!server){
			address = address || 'tcp://' + (process.env.DIGGER_NODE_HOST || '127.0.0.1') + ':' + (process.env.DIGGER_NODE_PORT || self.next_port++);

			serverrunner = Warehouse();
			
			server = self.telegraft.rpcserver({
				id:utils.littleid(),
				protocol:'rpc',
				address:address
			})

			server.on('request', function(req, reply){
				serverrunner(req, reply);
			})
		}
		
		serverrunner.use(route, function(req, reply){
			req.headers['x-supplier-route'] = route;
			handler(req, reply, function(){
				reply('404:page not found');
			})
		})

		/*
		
			this announces us to the network
			
		*/
		server.bind(route);
	}

	/*
	
		return the digger-serve that will host our websites
		
	*/
	this.supplychain.www = function(){
		if(!www){
			var Server = require('digger-serve');
			www = Server();

			var port = (process.env.DIGGER_NODE_PORT || 80);

			www.server.listen(port, function(){
				console.log('www server listening on port: ' + port);
			})

			// feed the request down the supplychain
			www.app.on('digger:request', function(req, reply){

				/*
				
					it is very important that we pass to external_handler here

					this passes ONLY:

						method
						url
						headers
						body
					
				*/
				self.external_handler(req, reply);
			})
		}

		return www;
	}

	this.supplychain.build = _.bind(self.compile, self);

	this.supplychain.filepath = function(filepath){
		if(filepath.indexOf('/')==0){
			return filepath;
		}
		return path.normalize(self.application_root + '/' + filepath);
	}
}

/*

	the main object factory

	we pass the type and config

	if the type is 'code' then we are loading code from the application folder
	
*/
ModuleBuilder.prototype.compile = function(module, moduleconfig, custom_module){
	var self = this;
	moduleconfig = moduleconfig || {};
	config = moduleconfig.config || {};	

	var module_path = '';

	if(custom_module){
		module_path = module;

		if(module.match(/[\/\.]/) && module.indexOf('/')!=0){
			module_path = path.normalize(__dirname + '/modules/' + module + '.js');
		}
	}
	else{
		module_path = path.normalize(__dirname + '/modules/' + module + '.js');
	
		/*
		
			is the module actually code in the digger app
			
		*/
		if(module.match(/[\/\.]/)){
			module_path = path.normalize(this.application_root + '/' + module);
			config._custommodule = module_path;
			if(module_path.indexOf(this.application_root)!=0){
				console.error('error - you cannot load code from above your application: ' + module_path);
				process.exit();
			}
		}
		else{
			config._systemmodule = module;
		}

		/*
		
			this means we have custom code but should load it inside of a warehouse module
			
		*/
		if(moduleconfig._diggermodule){
			module_path = path.normalize(__dirname + '/modules/' + moduleconfig._diggermodule + '.js')
		}
	}
	

	if(!fs.existsSync(module_path)){
		console.error(module_path + ' not found');
		process.exit();
	}

	var factory = require(module_path);

	/*
	
		we pass the compile function to each module so they can include modules
		from the application codebase
		
	*/
	var pass_config = _.extend({
		id:moduleconfig.id,
		hq_endpoints:this.hq_endpoints
	}, config);

	// remove this or we get into a loop
	delete(pass_config._diggermodule);
	
	return factory(pass_config, this.supplychain);
}