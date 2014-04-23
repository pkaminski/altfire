module.exports = function(grunt) {

  grunt.initConfig({
    // Dist build
    closureCompiler: {
      options: {
        compilerFile: 'bower_components/closure-compiler/compiler.jar',
        compilerOpts: {
          'compilation_level': 'SIMPLE_OPTIMIZATIONS',
          'warning_level': 'verbose',
          'jscomp_off': ['checkTypes', 'fileoverviewTags', 'undefinedVars'],
          'summary_detail_level': 3,
          'language_in': 'ECMASCRIPT5',
          'output_wrapper': '"(function(window, undefined){%output%}).call(window);"'
        }
      },

      all: {
        src: 'src/**/*.js',
        dest: 'dist/altfire.min.js'
      }
    },
    // Testing
    karma: {
      unit: {
        configFile: 'test/karma.conf.js'
      }
    }
  });

  // Load all available grunt plugins from package.json
  require('matchdep').filterDev('grunt-*').forEach(grunt.loadNpmTasks);  
  
  // The tasks
  grunt.registerTask('default', ['closureCompiler']);
  grunt.registerTask('test', ['karma']);
};