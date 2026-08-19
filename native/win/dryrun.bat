@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set "PATH=C:\Program Files\LLVM\bin;%PATH%"
cd /d "C:\Users\Erfan Mola\Documents\bunium"
cmake --build vendor\cef-windows-x64\build-clang --config Release --target libcef_dll_wrapper -- -n > build-clang-dryrun.txt 2>&1