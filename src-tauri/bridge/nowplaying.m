// WinzAMP Now Playing bridge.
//
// macOS 15.4+ only answers MediaRemote queries for Apple-signed platform
// binaries, so a normal app bundle gets nil. This dylib is loaded *by*
// /usr/bin/perl (a platform binary) via DynaLoader; perl choosing to load it
// sidesteps both the entitlement gate and SIP's DYLD_INSERT restriction.
//
// It polls Now Playing and prints one compact JSON line per change to stdout,
// which the Rust side reads. Build: see build.rs.
#import <Foundation/Foundation.h>
#include <dlfcn.h>

typedef void (*GetInfo)(dispatch_queue_t, void (^)(NSDictionary *));
typedef void (*GetPlaying)(dispatch_queue_t, void (^)(Boolean));
typedef void (*RegisterNotify)(dispatch_queue_t);

static GetInfo gGetInfo;
static GetPlaying gGetPlaying;
static dispatch_queue_t gQueue;
static NSString *gLastLine = nil;

static NSString *jsonString(NSString *s) {
  if (!s) return @"null";
  NSData *d = [NSJSONSerialization dataWithJSONObject:@[ s ] options:0 error:nil];
  NSString *arr = [[NSString alloc] initWithData:d encoding:NSUTF8StringEncoding];
  // strip the surrounding [ ] to get just the quoted, escaped string
  return [arr substringWithRange:NSMakeRange(1, arr.length - 2)];
}

static double num(NSDictionary *i, NSString *k) {
  id v = i[k];
  return [v respondsToSelector:@selector(doubleValue)] ? [v doubleValue] : 0;
}

static void emit(void) {
  gGetPlaying(gQueue, ^(Boolean playing) {
    gGetInfo(gQueue, ^(NSDictionary *i) {
      NSString *title = i[@"kMRMediaRemoteNowPlayingInfoTitle"];
      NSString *artist = i[@"kMRMediaRemoteNowPlayingInfoArtist"];
      NSString *album = i[@"kMRMediaRemoteNowPlayingInfoAlbum"];
      NSString *line = [NSString
          stringWithFormat:@"{\"playing\":%@,\"title\":%@,\"artist\":%@,\"album\":%@,"
                           @"\"elapsed\":%.2f,\"duration\":%.2f,\"rate\":%.2f}",
                           playing ? @"true" : @"false", jsonString(title),
                           jsonString(artist), jsonString(album),
                           num(i, @"kMRMediaRemoteNowPlayingInfoElapsedTime"),
                           num(i, @"kMRMediaRemoteNowPlayingInfoDuration"),
                           num(i, @"kMRMediaRemoteNowPlayingInfoPlaybackRate")];
      // De-dupe: only print when something changed (ignoring elapsed drift,
      // which the UI extrapolates from rate anyway).
      if (![line isEqualToString:gLastLine]) {
        gLastLine = line;
        printf("%s\n", line.UTF8String);
        fflush(stdout);
      }
    });
  });
}

__attribute__((constructor)) static void start(void) {
  void *h = dlopen("/System/Library/PrivateFrameworks/MediaRemote.framework/"
                   "MediaRemote",
                   RTLD_NOW);
  if (!h) {
    fprintf(stderr, "winzamp-bridge: cannot load MediaRemote\n");
    return;
  }
  gGetInfo = (GetInfo)dlsym(h, "MRMediaRemoteGetNowPlayingInfo");
  gGetPlaying = (GetPlaying)dlsym(h, "MRMediaRemoteGetNowPlayingApplicationIsPlaying");
  RegisterNotify reg =
      (RegisterNotify)dlsym(h, "MRMediaRemoteRegisterForNowPlayingNotifications");
  gQueue = dispatch_queue_create("com.jasonsutter.winzamp.np", 0);
  if (!gGetInfo || !gGetPlaying) {
    fprintf(stderr, "winzamp-bridge: missing MediaRemote symbols\n");
    return;
  }

  // Push updates on the system's Now Playing notifications…
  if (reg) reg(gQueue);
  NSNotificationCenter *nc = [NSNotificationCenter defaultCenter];
  void (^onChange)(NSNotification *) = ^(NSNotification *_) { emit(); };
  for (NSString *name in @[
         @"kMRMediaRemoteNowPlayingInfoDidChangeNotification",
         @"kMRMediaRemoteNowPlayingApplicationIsPlayingDidChangeNotification",
         @"kMRMediaRemoteNowPlayingApplicationClientStateDidChange"
       ]) {
    [nc addObserverForName:name object:nil queue:nil usingBlock:onChange];
  }

  // …and poll as a fallback (some apps update metadata without notifying).
  dispatch_source_t timer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, gQueue);
  dispatch_source_set_timer(timer, DISPATCH_TIME_NOW, 1 * NSEC_PER_SEC,
                            100 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{ emit(); });
  dispatch_resume(timer);
  static dispatch_source_t keep;
  keep = timer;

  emit();
  // perl's DynaLoader returns after load; keep the process alive so our
  // observers and timer run.
  [[NSThread new] start]; // ensure the run loop machinery is multithreaded
  dispatch_async(dispatch_get_main_queue(), ^{});
  [[NSRunLoop mainRunLoop] run];
}
