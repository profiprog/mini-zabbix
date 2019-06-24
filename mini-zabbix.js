#!/usr/bin/env node
"use strict";

const spawn = require('child_process').spawn;
const fs = require('fs');
const stream = require('stream');
const path = require('path');
const os = require('os');
const nodemailer = require('nodemailer');

let now = () => new Date();
let format = _ => _.getFullYear()
		+ '-' + ("0" + (_.getMonth() + 1)).substr(-2)
		+ '-' + ("0" + _.getDate()).substr(-2)
		+ ' ' + ("0" + _.getHours()).substr(-2)
		+ ':' + ("0" + _.getMinutes()).substr(-2)
		+ ':' + ("0" + _.getSeconds()).substr(-2)
		+ '.' + ("00" + _.getMilliseconds()).substr(-3);
let loadJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
let saveJson = (filename,json) => fs.writeFileSync(filename, JSON.stringify(json, null, 2), 'utf8');
let repeatStr = (count, str) => new Array(count + 1).join(str);

let consoleOutput = (array=[], partial='') => {
	if (array instanceof stream.Readable) {
		let stream = array;
		array = [];
		stream.setEncoding('utf8');
		stream.on('data', chunk => {
			array.push(...chunk.split(/\n/g).map((it, i, ar) => i + 1 === ar.length ? it : it + '\n'));
			if (array[array.length - 1] === '') array.pop();
		});
	}
	return buffer => {
		if (buffer) {
			let lines = buffer.toString().split(/\n/g);
			let last = lines.pop();
			for (let i = 0; i < lines.length; i++) {
				array.push(partial ? partial + lines[i] : lines[i]);
				partial = '';
			}
			partial = last;
		}
		else if (partial) array.push(partial);
		return array;
	};
};

let shell = (cmd, cwd) => new Promise(resolve => {
	let time = format(now());
	if (typeof cmd === 'string') cmd = [ "/bin/bash", "-l", "-c", cmd ];
	let opts = { stdio: [ 'ignore', 'pipe', 'pipe' ] };
	if (cwd) opts.cwd = resolveCwd(cwd);
	let proc = spawn(cmd.shift(),  cmd, opts);
	let out = consoleOutput(proc.stdout);
	let err = consoleOutput(proc.stderr);
	proc.on('error', e => err(e.toString() + '\n'));
	proc.on('close', exitCode => {
		let stdout = out(), stderr = err();
		let response = { time };
		if (exitCode) response.exitCode = exitCode;
		if (stdout.length) response.stdout = stdout;
		if (stderr.length) response.stderr = stderr;
		resolve(response);
	});
});

let runProc = (itemIndex, cmd, cwd) => shell(cmd, cwd).then(response => {
	if (!response.exitCode && response.stdout) {
		response.value = response.stdout.join('\n').trim();
		delete response.stdout;
	}
	else response.value = null;
	return {itemIndex,response};
}).catch(e => ({itemIndex, value:null, response:asErrorObj(e)}));

let itemSelector = {
	is_same: (values, param, source) => {
		let m;
		if((m = param.match(/^#(\d+)/))) {
			let pos = parseInt(m[1]);
			if (!pos) throw new Error(`Position must be greater than 0\n${source(1, m[1])}`);
			return pos <= values.length && !!values.slice(0, pos).reduce((a, b) => a && a.value === b.value ? a : false);
		}
		throw new Error(`Unknown parameter: '${param}'\n${source(0, param)}`);
	},
	last: (values, param, source) => {
		let m;
		if((m = param.match(/^#(\d+)/))) {
			let pos = parseInt(m[1]);
			if (!pos) throw new Error(`Position must be greater than 0\n${source(1, m[1])}`);
			return pos > values.length ? null : values[pos - 1].value;
		}
		throw new Error(`Unknown parameter: '${param}'\n${source(0, param)}`);
	}
};

let asErrorObj = e => {
	let msg = e.toString();
	return {
		msg: msg.indexOf('\n') >= 0 ? msg.split('\n') : msg,
		stack: e.stack.substr(e.toString().length).trim().split(/\s*\n\s*/g)
	};
};

let formatPosition = (str, where, initialIndex = 0) => (index, highlightStr) => {
	if (highlightStr === undefined) return formatPosition(str, where, initialIndex + index);
	index += initialIndex;
	let lines = str.split('\n');
	let line = 0, prefix, size = highlightStr.length || 1;
	while (index > lines[line].length) index -= lines[line++].length + 1;
	prefix = ` at line#${line + 1}:${index + 1}${size > 1 ? `-${index + size}` : ''}: `;
	return where + '\n' + prefix + lines[line] + '\n' +
			repeatStr(prefix.length + index, ' ') +
			repeatStr(size, '^') +
			repeatStr(lines[line].length - index - size, ' ');
};

let isStr = val => typeof val === 'string' || Array.isArray(val) && val.reduce((prev, item) => prev && typeof item === 'string', true);

let cachedActionProperties = (action, ctx) => {
	let cache = {};
	return name => {
		if (cache.hasOwnProperty(name)) return cache[name];
		return cache[name] = isStr(action[name]) ? resolvePlaceholders(action[name], ext({where:name}, ctx)) : action[name];
	};
};

let actionTypes = {
	mail: (action, ctx) => new Promise((resolve, reject) => {
		let prop = cachedActionProperties(action, ctx);
		nodemailer.createTransport({
			service: "gmail",
			auth: {
				user: prop('username') || prop('from'),
				pass: prop('password')
			}
		}).sendMail({
			from: prop('from') || prop('username'),
			to: prop('to') || prop('username'),
			cc: prop('cc'),
			bcc: prop('bcc'),
			replyTo: prop('replyTo') || prop('username'),
			subject: prop('subject'),
			[action.bodyType === 'html' ? 'html' : 'text']: prop('body')
		}, function (error, info) {
			if (error) reject(error);
			else resolve('Email sent: ' + info.response);
		});
	}),
	shell: (action, ctx) => {
		delete action.lastExecution;
		let context = ext({where: 'command'}, ctx);
		let resolver = _ => resolvePlaceholders(_, context);
		if (action.expand) resolver(action.command); // just for check syntax
		let cmd = action.expand ? action.command.map(resolver) : action.command.slice();
		return shell(cmd, action.cwd).catch(e => ext(asErrorObj(e), {
			time: format(now())
		})).then(_ => action.lastExecution = _);
	}
};

let resolveActions = (actions, resolve, ctx) => {
	if (!actions || actions.length === 0) resolve();
	else Promise.all(actions.map(action => {
		let actionLogic = actionTypes[action.type];
		if (!actionLogic) throw new Error("Unknown action type: " + action.type);
		delete action.error;
		return actionLogic(action, ctx).catch(e => action.error = asErrorObj(e));
	})).then(resolve);
};

let ext = (target, config) => {
	Object.keys(config).forEach(key => {
		if (!target.hasOwnProperty(key)) target[key] = config[key];
	});
	return target;
};
let quoteString = val => typeof val === 'string' ? `'${val.replace(/'/g, "\\'")}'` : val;
let echoExpressions = {
	"<": '{',
	">": '{'
};
let variables = {
	whoami: () => os.userInfo().username,
	hostname: () => os.hostname(),
	env: name => process.env[name],
	trigger: (key, ctx) => ctx.trigger[key],
	item: (itemExpr, ctx) => {
		let m = itemExpr.match(/\.(\w+)\((.*)\)$/);
		if (!m) m = [itemExpr, 'last', '#1'];
		else m[0] = itemExpr.substring(0, m.index);
		if (!ctx.items[m[0]]) throw new Error(`Unknown item '${m[0]}'${ctx.pos(0, m[0])}`);
		if (!itemSelector[m[1]]) throw new Error(`Unsupported selector '${m[1]}'${ctx.pos(m.index + 1, m[1])}`);
		return itemSelector[m[1]](ctx.items[m[0]], m[2], ctx.pos(m.index + m[1].length + 2));
	}
};

let resolveCwd = cwd => path.isAbsolute(cwd) ? cwd :
	path.resolve(path.dirname(variables["config.filename"]()), cwd);

let resolvePlaceholders = (str, context) => {
	if (Array.isArray(str)) str = str.join('\n');
	let pos = formatPosition(str, context.where ? ` in ${context.where}` : '');
	let trasform = context.transformPlaceholderValue || (_ => _);
	return str.replace(/{([^}]+)}/g, (m0, expr, offset) => {
		if (echoExpressions.hasOwnProperty(expr)) return echoExpressions[expr];
		offset++;
		let i = expr.indexOf(':'), prefix = expr.substr(0, i), name = expr.substr(i + 1);
		if (!prefix && variables[expr]) return trasform(variables[expr](ext({pos:pos(offset)}, context)));
		if (variables[prefix]) return trasform(variables[prefix](name, ext({pos:pos(offset + prefix.length + 1)}, context)));
		throw new Error(`Unsupported expression: '${expr}'${pos(offset, expr)}`);
	});
};

function processTrigger(items) {
	delete this.error;
	this.lastProcessingTime = format(now());
	let context = { trigger: this, items };
	return new Promise(resolve => {
		try {
			let condition = resolvePlaceholders(this.expression, ext({
				transformPlaceholderValue: quoteString,
				where: "expression"
			}, context));
			//TODO eval in sandbox: node -p "JSON.stringify(${condition})"
			let status = JSON.parse(eval(`JSON.stringify(${condition})`)) ? 'up' : 'down';
			if (this.status === status) { resolve(); return; }
			this.status = status;
			this.since = this.lastProcessingTime;
			resolveActions(this[status+"-actions"], resolve, context);
		} catch (e) {
			this.error = asErrorObj(e);
			resolveActions(this["error-actions"], resolve, context);
		}
	});
}

let pushItemValue = (item, response) => {
	let values = (item.lastValues||(item.lastValues=[]));
	values.unshift(response);
	if (typeof item.history === 'number' && values.length > item.history) {
		let removeCount = values.length - item.history;
		values.splice(values.length - removeCount, removeCount);
	}
};

if (require.main === module) {
	let args = process.argv.slice(2);
	if (args.length === 0 || args.length === 1 && ['help','--help','-h','-?'].indexOf(args[0]) >= 0) {
		console.info('A configuration file is required as argument.\n' +
			'Open https://github.com/profiprog/mini-zabbix/blob/master/README.md\n' +
			'to see how the configuration file should looks like.');
	}
	else {
		args.forEach(configFile => {
			configFile = path.resolve(configFile);
			variables["config.filename"] = () => configFile;
			let config = loadJson(configFile);
			Promise.all(config.items.reduce((resolvingValues, item, i) => {
				if (item.cmd) resolvingValues.push(runProc(i, item.cmd, item.cwd));
				return resolvingValues;
			},[])).then(values => {
				values.forEach(result => pushItemValue(config.items[result.itemIndex], result.response));
				let items = config.items.reduce((res, item) => {
					res[item.name] = item.lastValues;
					return res;
				}, {});
				return Promise.all(config.triggers.map(trigger => processTrigger.call(trigger, items)));
			}).then(() => {
				saveJson(configFile, config);
			}).catch(e => {
				console.error(e)
				process.exit(1);
			});
		});
	}
}
