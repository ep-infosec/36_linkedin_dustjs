(function(root, factory) {
  if (typeof define === "function" && define.amd && define.amd.dust === true) {
    define("dust.compile", ["dust.core", "dust.parse"], function(dust, parse) {
      return factory(parse, dust).compile;
    });
  } else if (typeof exports === 'object') {
    // in Node, require this file if we want to use the compiler as a standalone module
    module.exports = factory(require('./parser').parse, require('./dust'));
  } else {
    // in the browser, store the factory output if we want to use the compiler directly
    factory(root.dust.parse, root.dust);
  }
}(this, function(parse, dust) {
  var compiler = {},
      isArray = dust.isArray;

  var escape = (typeof JSON === 'undefined') ?
                  function(str) { return '"' + escapeToJsSafeString(str) + '"';} :
                  JSON.stringify;

  compiler.compile = function(source, name) {
    // the name parameter is optional.
    // this can happen for templates that are rendered immediately (renderSource which calls compileFn) or
    // for templates that are compiled as a callable (compileFn)
    //
    // for the common case (using compile and render) a name is required so that templates will be cached by name and rendered later, by name.

    try {
      var ast = filterAST(parse(source));
      return compile(ast, name);
    } catch (err) {
      if (!err.location) {
        throw err;
      }
      throw new SyntaxError(err.message + ' [' + name + ':' + err.location.start.line + ':' + err.location.start.column + ']');
    }
  };

  function filterAST(ast) {
    var context = {};
    return compiler.filterNode(context, ast);
  }

  compiler.filterNode = function(context, node) {
    return compiler.optimizers[node[0]](context, node);
  };

  compiler.optimizers = {
    body:      compactBuffers,
    buffer:    noop,
    special:   convertSpecial,
    format:    format,
    reference: visit,
    '#':       visit,
    '?':       visit,
    '^':       visit,
    '<':       visit,
    '+':       visit,
    '@':       visit,
    '%':       visit,
    partial:   visit,
    context:   visit,
    params:    visit,
    bodies:    visit,
    param:     visit,
    filters:   noop,
    key:       noop,
    path:      noop,
    literal:   noop,
    raw:       noop,
    comment:   nullify
  };

  compiler.pragmas = {
    esc: function(compiler, context, bodies) {
      var old = compiler.auto,
          out;
      if (!context) {
        context = 'h';
      }
      compiler.auto = (context === 's') ? '' : context;
      out = compileParts(compiler, bodies.block);
      compiler.auto = old;
      return out;
    }
  };

  function visit(context, node) {
    var out = [node[0]],
        i, len, res;
    for (i=1, len=node.length; i<len; i++) {
      res = compiler.filterNode(context, node[i]);
      if (res) {
        out.push(res);
      }
    }
    return out;
  }

  // Compacts consecutive buffer nodes into a single node
  function compactBuffers(context, node) {
    var out = [node[0]],
        memo, i, len, res;
    for (i=1, len=node.length; i<len; i++) {
      res = compiler.filterNode(context, node[i]);
      if (res) {
        if (res[0] === 'buffer' || res[0] === 'format') {
          if (memo) {
            memo[0] = (res[0] === 'buffer') ? 'buffer' : memo[0];
            memo[1] += res.slice(1).join('');
          } else {
            memo = res;
            out.push(res);
          }
        } else {
          memo = null;
          out.push(res);
        }
      }
    }
    return out;
  }

  var specialChars = {
    's': ' ',
    'n': '\n',
    'r': '\r',
    'lb': '{',
    'rb': '}'
  };

  function convertSpecial(context, node) {
    return ['buffer', specialChars[node[1]], node[2], node[3]];
  }

  function noop(context, node) {
    return node;
  }

  function nullify(){}

  function format(context, node) {
    if(dust.config.whitespace) {
      // Format nodes are in the form ['format', eol, whitespace],
      // which is unlike other nodes in that there are two pieces of content
      // Join eol and whitespace together to normalize the node format
      node.splice(1, 2, node.slice(1).join(''));
      return node;
    }
    return null;
  }

  function compile(ast, name) {
    var context = {
      name: name,
      bodies: [],
      blocks: {},
      index: 0,
      auto: 'h'
    },
    escapedName = dust.escapeJs(name),
    AMDName = name? '"' + escapedName + '",' : '',
    compiled = 'function(dust){',
    entry = compiler.compileNode(context, ast),
    iife;

    if(name) {
      compiled += 'dust.register("' + escapedName + '",' + entry + ');';
    }

    compiled += compileBlocks(context) +
                compileBodies(context) +
                'return ' + entry + '}';

    iife = '(' + compiled + '(dust));';

    if(dust.config.amd) {
      return 'define(' + AMDName + '["dust.core"],' + compiled + ');';
    } else if(dust.config.cjs) {
      return 'module.exports=function(dust){' +
             'var tmpl=' + iife +
             'var f=' + loaderFor().toString() + ';' +
             'f.template=tmpl;return f}';
    } else {
      return iife;
    }
  }

  function compileBlocks(context) {
    var out = [],
        blocks = context.blocks,
        name;

    for (name in blocks) {
      if (Object.prototype.hasOwnProperty.call(blocks, name)) {
        out.push('"' + name + '":' + blocks[name]);
      }
    }
    if (out.length) {
      context.blocks = 'ctx=ctx.shiftBlocks(blocks);';
      return 'var blocks={' + out.join(',') + '};';
    } else {
      context.blocks = '';
    }
    return context.blocks;
  }

  function compileBodies(context) {
    var out = [],
        bodies = context.bodies,
        blx = context.blocks,
        i, len;

    for (i=0, len=bodies.length; i<len; i++) {
      out[i] = 'function body_' + i + '(chk,ctx){' +
          blx + 'return chk' + bodies[i] + ';}body_' + i + '.__dustBody=!0;';
    }
    return out.join('');
  }

  function compileParts(context, body) {
    var parts = '',
        i, len;
    for (i=1, len=body.length; i<len; i++) {
      parts += compiler.compileNode(context, body[i]);
    }
    return parts;
  }

  compiler.compileNode = function(context, node) {
    return compiler.nodes[node[0]](context, node);
  };

  compiler.nodes = {
    body: function(context, node) {
      var id = context.index++,
          name = 'body_' + id;
      context.bodies[id] = compileParts(context, node);
      return name;
    },

    buffer: function(context, node) {
      return '.w(' + escape(node[1]) + ')';
    },

    format: function(context, node) {
      return '.w(' + escape(node[1]) + ')';
    },

    reference: function(context, node) {
      return '.f(' + compiler.compileNode(context, node[1]) +
        ',ctx,' + compiler.compileNode(context, node[2]) + ')';
    },

    '#': function(context, node) {
      return compileSection(context, node, 'section');
    },

    '?': function(context, node) {
      return compileSection(context, node, 'exists');
    },

    '^': function(context, node) {
      return compileSection(context, node, 'notexists');
    },

    '<': function(context, node) {
      var bodies = node[4];
      for (var i=1, len=bodies.length; i<len; i++) {
        var param = bodies[i],
            type = param[1][1];
        if (type === 'block') {
          context.blocks[node[1].text] = compiler.compileNode(context, param[2]);
          return '';
        }
      }
      return '';
    },

    '+': function(context, node) {
      if (typeof(node[1].text) === 'undefined'  && typeof(node[4]) === 'undefined'){
        return '.b(ctx.getBlock(' +
              compiler.compileNode(context, node[1]) +
              ',chk, ctx),' + compiler.compileNode(context, node[2]) + ', {},' +
              compiler.compileNode(context, node[3]) +
              ')';
      } else {
        return '.b(ctx.getBlock(' +
            escape(node[1].text) +
            '),' + compiler.compileNode(context, node[2]) + ',' +
            compiler.compileNode(context, node[4]) + ',' +
            compiler.compileNode(context, node[3]) +
            ')';
      }
    },

    '@': function(context, node) {
      return '.h(' +
        escape(node[1].text) +
        ',' + compiler.compileNode(context, node[2]) + ',' +
        compiler.compileNode(context, node[4]) + ',' +
        compiler.compileNode(context, node[3]) + ',' +
        compiler.compileNode(context, node[5]) +
        ')';
    },

    '%': function(context, node) {
      // TODO: Move these hacks into pragma precompiler
      var name = node[1][1],
          rawBodies,
          bodies,
          rawParams,
          params,
          ctx, b, p, i, len;
      if (!compiler.pragmas[name]) {
        return '';
      }

      rawBodies = node[4];
      bodies = {};
      for (i=1, len=rawBodies.length; i<len; i++) {
        b = rawBodies[i];
        bodies[b[1][1]] = b[2];
      }

      rawParams = node[3];
      params = {};
      for (i=1, len=rawParams.length; i<len; i++) {
        p = rawParams[i];
        params[p[1][1]] = p[2][1];
      }

      ctx = node[2][1] ? node[2][1].text : null;

      return compiler.pragmas[name](context, ctx, bodies, params);
    },

    partial: function(context, node) {
      return '.p(' +
          compiler.compileNode(context, node[1]) +
          ',ctx,' + compiler.compileNode(context, node[2]) +
          ',' + compiler.compileNode(context, node[3]) + ')';
    },

    context: function(context, node) {
      if (node[1]) {
        return 'ctx.rebase(' + compiler.compileNode(context, node[1]) + ')';
      }
      return 'ctx';
    },

    params: function(context, node) {
      var out = [];
      for (var i=1, len=node.length; i<len; i++) {
        out.push(compiler.compileNode(context, node[i]));
      }
      if (out.length) {
        return '{' + out.join(',') + '}';
      }
      return '{}';
    },

    bodies: function(context, node) {
      var out = [];
      for (var i=1, len=node.length; i<len; i++) {
        out.push(compiler.compileNode(context, node[i]));
      }
      return '{' + out.join(',') + '}';
    },

    param: function(context, node) {
      return compiler.compileNode(context, node[1]) + ':' + compiler.compileNode(context, node[2]);
    },

    filters: function(context, node) {
      var list = [];
      for (var i=1, len=node.length; i<len; i++) {
        var filter = node[i];
        list.push('"' + filter + '"');
      }
      return '"' + context.auto + '"' +
        (list.length ? ',[' + list.join(',') + ']' : '');
    },

    key: function(context, node) {
      return 'ctx.get(["' + node[1] + '"], false)';
    },

    path: function(context, node) {
      var current = node[1],
          keys = node[2],
          list = [];

      for (var i=0,len=keys.length; i<len; i++) {
        if (isArray(keys[i])) {
          list.push(compiler.compileNode(context, keys[i]));
        } else {
          list.push('"' + keys[i] + '"');
        }
      }
      return 'ctx.getPath(' + current + ', [' + list.join(',') + '])';
    },

    literal: function(context, node) {
      return escape(node[1]);
    },
    raw: function(context, node) {
      return ".w(" + escape(node[1]) + ")";
    }
  };

  function compileSection(context, node, cmd) {
    return '.' + (dust._aliases[cmd] || cmd) + '(' +
      compiler.compileNode(context, node[1]) +
      ',' + compiler.compileNode(context, node[2]) + ',' +
      compiler.compileNode(context, node[4]) + ',' +
      compiler.compileNode(context, node[3]) +
      ')';
  }

  var BS = /\\/g,
      DQ = /"/g,
      LF = /\f/g,
      NL = /\n/g,
      CR = /\r/g,
      TB = /\t/g;
  function escapeToJsSafeString(str) {
    return str.replace(BS, '\\\\')
              .replace(DQ, '\\"')
              .replace(LF, '\\f')
              .replace(NL, '\\n')
              .replace(CR, '\\r')
              .replace(TB, '\\t');
  }

  function renderSource(source, context, callback) {
    var tmpl = dust.loadSource(dust.compile(source));
    return loaderFor(tmpl)(context, callback);
  }

  function compileFn(source, name) {
    var tmpl = dust.loadSource(dust.compile(source, name));
    return loaderFor(tmpl);
  }

  function loaderFor(tmpl) {
    return function load(ctx, cb) {
      var fn = cb ? 'render' : 'stream';
      return dust[fn](tmpl, ctx, cb);
    };
  }

  // expose compiler methods
  dust.compiler = compiler;
  dust.compile = dust.compiler.compile;
  dust.renderSource = renderSource;
  dust.compileFn = compileFn;

  // DEPRECATED legacy names. Removed in 2.8.0
  dust.filterNode = compiler.filterNode;
  dust.optimizers = compiler.optimizers;
  dust.pragmas = compiler.pragmas;
  dust.compileNode = compiler.compileNode;
  dust.nodes = compiler.nodes;

  return compiler;

}));
