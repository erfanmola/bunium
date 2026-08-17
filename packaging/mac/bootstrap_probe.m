// Probe: bootstrap_look_up each name passed as argv; print result. Used to
// see which MachPortRendezvousServer name the browser process registered.
#import <Foundation/Foundation.h>
#import <mach/mach.h>
#import <servers/bootstrap.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    mach_port_t bp = MACH_PORT_NULL;
    task_get_bootstrap_port(mach_task_self(), &bp);
    printf("self pid: %d\n", (int)getpid());
    NSBundle *mb = [NSBundle mainBundle];
    printf("mainBundle path: %s\n", mb.bundlePath.UTF8String);
    printf("bundleIdentifier: %s\n",
           (mb.bundleIdentifier ?: @"(null)").UTF8String);
    for (int i = 1; i < argc; i++) {
      mach_port_t port = MACH_PORT_NULL;
      kern_return_t kr = bootstrap_look_up(bp, argv[i], &port);
      printf("lookup %-70s -> %s (port %u)\n", argv[i],
             mach_error_string(kr), port);
      if (port != MACH_PORT_NULL) {
        mach_port_deallocate(mach_task_self(), port);
      }
    }
  }
  return 0;
}
