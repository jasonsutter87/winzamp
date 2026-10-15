# Loads the WinzAMP Now Playing dylib from inside perl (a platform binary),
# which is what lets MediaRemote answer us. The dylib's constructor takes over
# and runs its own run loop, so this script never returns.
require DynaLoader;
my $lib = $ARGV[0] or die "usage: perl load.pl <dylib>\n";
DynaLoader::dl_load_file($lib, 0)
  or die "dl_load_file failed: " . DynaLoader::dl_error() . "\n";
# The dylib runs [NSRunLoop run]; if it ever returns, just idle.
while (1) { sleep 3600; }
