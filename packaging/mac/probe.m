#import <Foundation/Foundation.h>
int main(void) {
  @autoreleasepool {
    NSBundle *mb = [NSBundle mainBundle];
    NSLog(@"argv0: %@", [[NSProcessInfo processInfo] arguments].firstObject);
    NSLog(@"mainBundle path: %@", mb.bundlePath);
    NSLog(@"bundleIdentifier: %@", mb.bundleIdentifier);
    NSLog(@"executableURL: %@", mb.executableURL);
  }
  return 0;
}
