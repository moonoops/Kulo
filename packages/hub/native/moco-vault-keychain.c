#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static void zero_bytes(void *memory, size_t size) {
  volatile UInt8 *bytes = memory;
  while (size-- > 0) *bytes++ = 0;
}

/* Only this dedicated executable is trusted; Node and command-line security tools are not. */
static int error_code(OSStatus status) {
  if (status == errSecItemNotFound) return 10;
  if (status == errSecInteractionNotAllowed || status == errSecAuthFailed || status == errSecUserCanceled) return 11;
  return 12;
}

static CFMutableDictionaryRef query_for(CFStringRef account) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, CFSTR("io.moco.connection-vault"));
  CFDictionarySetValue(query, kSecAttrAccount, account);
  return query;
}

static int copy_key(CFStringRef account) {
  CFMutableDictionaryRef query = query_for(account);
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching(query, &result);
  CFRelease(query);
  if (status != errSecSuccess) return error_code(status);
  if (result == NULL || CFGetTypeID(result) != CFDataGetTypeID() || CFDataGetLength((CFDataRef)result) != 32) {
    if (result != NULL) CFRelease(result);
    return 12;
  }
  const UInt8 *bytes = CFDataGetBytePtr((CFDataRef)result);
  size_t written = 0;
  while (written < 32) {
    ssize_t count = write(STDOUT_FILENO, bytes + written, 32 - written);
    if (count <= 0) { CFRelease(result); return 12; }
    written += (size_t)count;
  }
  CFRelease(result);
  return 0;
}

static int create_key(CFStringRef account) {
  SecTrustedApplicationRef application = NULL;
  OSStatus status = SecTrustedApplicationCreateFromPath(NULL, &application);
  if (status != errSecSuccess) return error_code(status);
  const void *applications[] = { application };
  CFArrayRef trusted = CFArrayCreate(NULL, applications, 1, &kCFTypeArrayCallBacks);
  SecAccessRef access = NULL;
  status = SecAccessCreate(CFSTR("Moco connection vault"), trusted, &access);
  CFRelease(trusted);
  CFRelease(application);
  if (status != errSecSuccess) return error_code(status);

  UInt8 bytes[32];
  status = SecRandomCopyBytes(kSecRandomDefault, sizeof(bytes), bytes);
  if (status != errSecSuccess) { CFRelease(access); return error_code(status); }
  CFDataRef data = CFDataCreate(NULL, bytes, sizeof(bytes));
  zero_bytes(bytes, sizeof(bytes));
  CFMutableDictionaryRef query = query_for(account);
  CFDictionarySetValue(query, kSecAttrLabel, CFSTR("Moco connection vault master key"));
  CFDictionarySetValue(query, kSecValueData, data);
  CFDictionarySetValue(query, kSecAttrAccess, access);
  status = SecItemAdd(query, NULL);
  CFRelease(query);
  CFRelease(data);
  CFRelease(access);
  if (status != errSecSuccess && status != errSecDuplicateItem) return error_code(status);
  return copy_key(account);
}

int main(int argc, const char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) return 0;
  SecKeychainSetUserInteractionAllowed(false);
  if (argc == 2 && strcmp(argv[1], "--status") == 0) {
    SecKeychainRef keychain = NULL;
    OSStatus status = SecKeychainCopyDefault(&keychain);
    if (status != errSecSuccess) return error_code(status);
    SecKeychainStatus flags = 0;
    status = SecKeychainGetStatus(keychain, &flags);
    CFRelease(keychain);
    if (status != errSecSuccess) return error_code(status);
    return (flags & kSecUnlockStateStatus) ? 0 : 11;
  }
  if (argc != 3 || strlen(argv[2]) != 64 || strspn(argv[2], "0123456789abcdef") != 64) return 12;
  CFStringRef account = CFStringCreateWithCString(NULL, argv[2], kCFStringEncodingUTF8);
  if (account == NULL) return 12;
  int result;
  if (strcmp(argv[1], "read") == 0) result = copy_key(account);
  else if (strcmp(argv[1], "create") == 0) {
    result = copy_key(account);
    if (result == 10) result = create_key(account);
  } else if (strcmp(argv[1], "delete") == 0) {
    CFMutableDictionaryRef query = query_for(account);
    OSStatus status = SecItemDelete(query);
    CFRelease(query);
    result = status == errSecSuccess || status == errSecItemNotFound ? 0 : error_code(status);
  } else result = 12;
  CFRelease(account);
  return result;
}
