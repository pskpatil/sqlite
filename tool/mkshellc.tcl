#!/usr/bin/tclsh
#
# Run this script to generate the "shell.c" source file from 
# constituent parts.
#
# No arguments are required.  This script determines the location
# of its input files relative to the location of the script itself.
# This script should be tool/mkshellc.tcl.  If the directory holding
# the script is $DIR, then the component parts are located in $DIR/../src
# and $DIR/../ext/misc.
#
set topdir [file dir [file dir [file normal $argv0]]]
set out stdout
fconfigure stdout -translation binary
puts $out {/* DO NOT EDIT!
** This file is automatically generated by the script in the canonical
** SQLite source tree at tool/mkshellc.tcl.  That script combines source
** code from various constituent source files of SQLite into this single
** "shell.c" file used to implement the SQLite command-line shell.
**
** Most of the code found below comes from the "src/shell.c.in" file in
** the canonical SQLite source tree.  That main file contains "INCLUDE"
** lines that specify other files in the canonical source tree that are
** inserted to getnerate this complete program source file.
**
** The code from multiple files is combined into this single "shell.c"
** source file to help make the command-line program easier to compile.
**
** To modify this program, get a copy of the canonical SQLite source tree,
** edit the src/shell.c.in" and/or some of the other files that are included
** by "src/shell.c.in", then rerun the tool/mkshellc.tcl script.
*/}
set in [open $topdir/src/shell.c.in]
fconfigure $in -translation binary
proc omit_redundant_typedefs {line} {
  global typedef_seen
  if {[regexp {^typedef .* ([a-zA-Z0-9_]+);} $line all typename]} {
    # --------------------\y jimtcl does not support \y
    if {[info exists typedef_seen($typename)]} {
      return "/* [string map {/* // */ //} $line] */"
    }
    set typedef_seen($typename) 1
  }
  return $line
}
set iLine 0
while {1} {
  set lx [omit_redundant_typedefs [gets $in]]
  if {[eof $in]} break;
  incr iLine
  if {[regexp {^INCLUDE } $lx]} {
    set cfile [lindex $lx 1]
    puts $out "/************************* Begin $cfile ******************/"
#   puts $out "#line 1 \"$cfile\""
    set in2 [open $topdir/src/$cfile]
    fconfigure $in2 -translation binary
    while {![eof $in2]} {
      set lx [omit_redundant_typedefs [gets $in2]]
      if {[regexp {^# *include "sqlite} $lx]} {
        set lx "/* $lx */"
      }
      if {[regexp {^# *include "test_windirent.h"} $lx]} {
        set lx "/* $lx */"
      }
      set lx [string map [list __declspec(dllexport) {}] $lx]
      puts $out $lx
    }
    close $in2
    puts $out "/************************* End $cfile ********************/"
#   puts $out "#line [expr $iLine+1] \"shell.c.in\""
    continue
  }
  puts $out $lx
}
close $in
close $out
