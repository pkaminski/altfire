module.exports = function(grunt) {

  grunt.initConfig({
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
    }
  });

  // Load the plugin that provides the "uglify" task.
  require('matchdep').filterDev('grunt-*').forEach(grunt.loadNpmTasks);  
  
  // Default task(s).
  grunt.registerTask('default', ['closureCompiler']);
};