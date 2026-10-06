// The native session API must refuse anything but "<key>/g<generation>" so a
// caller can never point a request context at an arbitrary path.
import { app, BuniumSession } from "../src/index";
import { cstr, lib } from "../src/native";

app.init();
const rejected = [
  "../escape/g1",
  "/abs/g1",
  "key/../g1",
  "key/g0",
  "key/g1/extra",
  "Key/g1",
  "key/g1234567890",
  "key\\g1",
  "-key/g1",
];
let ok = true;
for (const name of rejected) {
  const pointer = lib.symbols.bunium_session_create(cstr(name));
  if (pointer) {
    ok = false;
    console.log(`accepted invalid native partition name: ${name}`);
    lib.symbols.bunium_session_release(pointer);
  }
}
const root = BuniumSession.storageRoot;
if (!root) ok = false;
console.log(`SESSION_NATIVE_VALIDATION:${ok ? "PASS" : "FAIL"} root=${root}`);
app.shutdown();
process.exit(ok ? 0 : 1);
