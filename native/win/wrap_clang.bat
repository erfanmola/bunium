@echo off
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
set "PATH=C:\Program Files\LLVM\bin;%PATH%"
cd /d "C:\Users\Erfan Mola\Documents\bunium"
cmake -S vendor\cef-windows-x64 -B vendor\cef-windows-x64\build-clang -G "NMake Makefiles" -DCMAKE_C_COMPILER=clang-cl -DCMAKE_CXX_COMPILER=clang-cl -DCMAKE_C_FLAGS="" -DCMAKE_CXX_FLAGS="" -DCMAKE_VERBOSE_MAKEFILE=ON
if errorlevel 1 exit /b 1
cmake --build vendor\cef-windows-x64\build-clang --config Release --target libcef_dll_wrapper
exit /b %errorlevel%