#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>
#import <OSAKit/OSAKit.h>
#import <sqlite3.h>
#include <sys/stat.h>
#include <errno.h>
#include <string.h>
#include <math.h>

#ifndef MOCO_JXA_SOURCE
#define MOCO_JXA_SOURCE "function moco() { throw new Error('MOCO_NATIVE:connection_app_unavailable'); }"
#endif

static NSDictionary *failure(NSString *code) { return @{ @"ok": @NO, @"error": @{ @"code": code } }; }
static NSDictionary *success(NSDictionary *result) { return @{ @"ok": @YES, @"result": result }; }
static void emit(NSDictionary *value) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:NULL];
  if (data == nil || data.length > 256 * 1024) data = [NSJSONSerialization dataWithJSONObject:failure(@"connection_app_failed") options:0 error:NULL];
  [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
}
static BOOL string_value(id value, NSUInteger max, BOOL required) {
  return [value isKindOfClass:[NSString class]] && [value length] <= max && (!required || [value length] > 0) && [value lengthOfBytesUsingEncoding:NSUTF8StringEncoding] == strlen([value UTF8String]);
}
static NSString *clip(NSString *value, NSUInteger max) {
  if (value.length <= max) return value;
  if (max > 0 && CFStringIsSurrogateHighCharacter([value characterAtIndex:max - 1])) max--;
  return [value substringToIndex:max];
}
static id sqlite_text(sqlite3_stmt *statement, int index) {
  if (sqlite3_column_type(statement, index) == SQLITE_NULL) return [NSNull null];
  const unsigned char *bytes = sqlite3_column_text(statement, index);
  int length = sqlite3_column_bytes(statement, index);
  NSString *text = bytes ? [[NSString alloc] initWithBytes:bytes length:(NSUInteger)length encoding:NSUTF8StringEncoding] : nil;
  return text ?: [NSNull null];
}
static NSString *sqlite_id(sqlite3_stmt *statement, int index) { return [NSString stringWithFormat:@"%lld", sqlite3_column_int64(statement, index)]; }
static id apple_date(sqlite3_stmt *statement, int index) {
  if (sqlite3_column_type(statement, index) == SQLITE_NULL) return [NSNull null];
  double value = (double)sqlite3_column_int64(statement, index);
  if (fabs(value) >= 100000000000.0) value /= 1000000000.0;
  value += 978307200.0;
  if (!isfinite(value) || value < -62135596800.0 || value > 253402300799.0) return [NSNull null];
  NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
  return [formatter stringFromDate:[NSDate dateWithTimeIntervalSince1970:value]] ?: (id)[NSNull null];
}

/* Read only the first length-framed NSString, never instantiate archived Objective-C classes.
 * Apple typedstream framing is corroborated by imsg's MIT TypedStreamParser.swift:
 * https://github.com/steipete/imsg/blob/main/Sources/IMsgCore/TypedStreamParser.swift
 */
static NSString *attributed_text(const unsigned char *bytes, NSUInteger size) {
  if (!bytes || size == 0 || size > 1024 * 1024) return nil;
  if (size >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe) return [[NSString alloc] initWithBytes:bytes + 2 length:size - 2 encoding:NSUTF16LittleEndianStringEncoding];
  if (size >= 2 && bytes[0] == 0xfe && bytes[1] == 0xff) return [[NSString alloc] initWithBytes:bytes + 2 length:size - 2 encoding:NSUTF16BigEndianStringEncoding];
  if (size < 13 || bytes[0] != 4 || bytes[1] != 11) return nil;
  BOOL little = memcmp(bytes + 2, "streamtyped", 11) == 0;
  if (!little && memcmp(bytes + 2, "typedstream", 11) != 0) return nil;
  for (NSUInteger index = 13; index + 2 < size; index++) {
    if (bytes[index] != 1 || bytes[index + 1] != 0x2b) continue;
    NSUInteger position = index + 2;
    unsigned char tag = bytes[position++];
    uint64_t count = 0;
    if (tag <= 0x7f) count = tag;
    else if (tag == 0x81 || tag == 0x82) {
      NSUInteger width = tag == 0x81 ? 2 : 4;
      if (width > size - position) return nil;
      for (NSUInteger offset = 0; offset < width; offset++) count |= (uint64_t)bytes[position + offset] << (8 * (little ? offset : width - 1 - offset));
      position += width;
    } else return nil;
    if (count > size - position || count > 1024 * 1024) return nil;
    return [[NSString alloc] initWithBytes:bytes + position length:(NSUInteger)count encoding:NSUTF8StringEncoding];
  }
  return nil;
}

static BOOL has_column(sqlite3 *database, const char *column) {
  sqlite3_stmt *statement = NULL;
  if (sqlite3_prepare_v2(database, "PRAGMA table_info('message')", -1, &statement, NULL) != SQLITE_OK) return NO;
  BOOL found = NO;
  while (sqlite3_step(statement) == SQLITE_ROW) {
    const char *name = (const char *)sqlite3_column_text(statement, 1);
    if (name && strcmp(name, column) == 0) { found = YES; break; }
  }
  sqlite3_finalize(statement);
  return found;
}
static BOOL bounded_limit(id value, int *limit) {
  if (![value isKindOfClass:[NSNumber class]]) return NO;
  double number = [value doubleValue];
  if (!isfinite(number) || floor(number) != number || number < 1 || number > 50) return NO;
  *limit = (int)number;
  return YES;
}
static BOOL positive_integer(NSString *value, sqlite3_int64 *result) {
  if (!string_value(value, 19, YES) || [value characterAtIndex:0] < '1' || [value characterAtIndex:0] > '9') return NO;
  const char *bytes = value.UTF8String;
  for (const char *cursor = bytes; *cursor; cursor++) if (*cursor < '0' || *cursor > '9') return NO;
  errno = 0;
  char *end = NULL;
  long long number = strtoll(bytes, &end, 10);
  if (errno == ERANGE || !end || *end || number <= 0) return NO;
  *result = (sqlite3_int64)number;
  return YES;
}

static NSDictionary *messages_database(NSDictionary *request) {
  NSString *databasePath = request[@"databasePath"], *action = request[@"action"];
  NSDictionary *params = [request[@"params"] isKindOfClass:[NSDictionary class]] ? request[@"params"] : @{};
  if (!string_value(databasePath, 4096, YES) || !databasePath.isAbsolutePath) return failure(@"connection_app_invalid_parameters");
  struct stat file;
  if (stat(databasePath.fileSystemRepresentation, &file) != 0) return failure(errno == ENOENT ? @"connection_messages_database_missing" : @"connection_messages_full_disk_access_required");
  if (!S_ISREG(file.st_mode)) return failure(@"connection_messages_schema_unsupported");
  sqlite3 *database = NULL;
  int opened = sqlite3_open_v2(databasePath.fileSystemRepresentation, &database, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_PRIVATECACHE, NULL);
  if (opened != SQLITE_OK || sqlite3_db_readonly(database, "main") != 1) { if (database) sqlite3_close(database); return failure(@"connection_messages_full_disk_access_required"); }
  sqlite3_busy_timeout(database, 1000);
  sqlite3_db_config(database, SQLITE_DBCONFIG_DEFENSIVE, 1, NULL);
  sqlite3_db_config(database, SQLITE_DBCONFIG_TRUSTED_SCHEMA, 0, NULL);
  sqlite3_exec(database, "PRAGMA query_only=ON", NULL, NULL, NULL);
  sqlite3_stmt *statement = NULL;
  NSDictionary *result = nil;
  const char *schema = "SELECT m.ROWID,m.guid,m.text,m.date,m.is_from_me,m.handle_id,c.ROWID,c.guid,c.display_name,c.chat_identifier,c.service_name,h.id FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID JOIN chat c ON c.ROWID=j.chat_id LEFT JOIN handle h ON h.ROWID=m.handle_id LIMIT 0";
  if (sqlite3_prepare_v2(database, schema, -1, &statement, NULL) != SQLITE_OK || sqlite3_step(statement) != SQLITE_DONE) result = failure(@"connection_messages_schema_unsupported");
  if (statement) { sqlite3_finalize(statement); statement = NULL; }
  if (!result && [action isEqualToString:@"messages.probe_read"]) result = success(@{ @"readable": @YES });
  int limit = 0;
  if (!result && !bounded_limit(params[@"limit"], &limit)) result = failure(@"connection_app_invalid_parameters");
  if (!result && [action isEqualToString:@"messages.list"]) {
    const char *sql = "SELECT c.guid,COALESCE(NULLIF(c.display_name,''),c.chat_identifier,''),c.service_name,MAX(m.date) FROM chat c JOIN chat_message_join j ON j.chat_id=c.ROWID JOIN message m ON m.ROWID=j.message_id GROUP BY c.ROWID ORDER BY MAX(m.date) DESC,c.ROWID DESC LIMIT ?";
    if (sqlite3_prepare_v2(database, sql, -1, &statement, NULL) != SQLITE_OK) result = failure(@"connection_messages_schema_unsupported");
    else {
      sqlite3_bind_int(statement, 1, limit + 1);
      NSMutableArray *chats = [NSMutableArray array];
      int status;
      while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
        id guid = sqlite_text(statement, 0);
        if (![guid isKindOfClass:[NSString class]] || [guid length] == 0) { result = failure(@"connection_messages_schema_unsupported"); break; }
        id name = sqlite_text(statement, 1), service = sqlite_text(statement, 2);
        [chats addObject:@{ @"chatId": clip(guid, 1024), @"name": [name isKindOfClass:[NSString class]] ? clip(name, 512) : @"", @"service": [service isKindOfClass:[NSString class]] ? clip(service, 40) : @"", @"lastMessageAt": apple_date(statement, 3) }];
      }
      if (!result && status != SQLITE_DONE) result = failure(@"connection_app_failed");
      if (!result) {
        BOOL more = chats.count > (NSUInteger)limit;
        if (more) [chats removeLastObject];
        result = success(@{ @"chats": chats, @"hasMore": @(more) });
      }
    }
  }
  if (!result && [action isEqualToString:@"messages.read"]) {
    NSString *chatId = params[@"chatId"];
    sqlite3_int64 before = 0;
    if (!string_value(chatId, 1024, YES) || (params[@"before"] && !positive_integer(params[@"before"], &before))) result = failure(@"connection_app_invalid_parameters");
    if (!result) {
      NSString *body = has_column(database, "attributedBody") ? @"CASE WHEN length(m.attributedBody)<=1048576 THEN m.attributedBody ELSE NULL END,length(m.attributedBody)" : @"NULL,0";
      NSString *service = has_column(database, "service") ? @"m.service" : @"NULL";
      NSString *attachments = has_column(database, "cache_has_attachments") ? @"m.cache_has_attachments" : @"0";
      NSString *sql = [NSString stringWithFormat:@"SELECT m.ROWID,m.guid,CASE WHEN length(CAST(m.text AS BLOB))<=1048576 THEN m.text ELSE NULL END,%@,m.date,m.is_from_me,h.id,%@,%@,length(CAST(m.text AS BLOB)) FROM message m JOIN chat_message_join j ON j.message_id=m.ROWID JOIN chat c ON c.ROWID=j.chat_id LEFT JOIN handle h ON h.ROWID=m.handle_id WHERE c.guid=? %@ ORDER BY m.ROWID DESC LIMIT ?", body, service, attachments, before ? @"AND m.ROWID<?" : @""];
      if (sqlite3_prepare_v2(database, sql.UTF8String, -1, &statement, NULL) != SQLITE_OK) result = failure(@"connection_messages_schema_unsupported");
      else {
        sqlite3_bind_text(statement, 1, chatId.UTF8String, -1, SQLITE_TRANSIENT);
        if (before) sqlite3_bind_int64(statement, 2, before);
        sqlite3_bind_int(statement, before ? 3 : 2, limit + 1);
        NSMutableArray *messages = [NSMutableArray array];
        BOOL more = NO, complete = YES;
        int status;
        while ((status = sqlite3_step(statement)) == SQLITE_ROW) {
          if (messages.count >= (NSUInteger)limit) { more = YES; break; }
          id plain = sqlite_text(statement, 2);
          NSString *messageText = [plain isKindOfClass:[NSString class]] ? plain : nil;
          NSString *textStatus = messageText.length ? @"plain" : @"empty";
          int bodyBytes = sqlite3_column_bytes(statement, 3);
          sqlite3_int64 bodySize = sqlite3_column_int64(statement, 4), plainSize = sqlite3_column_int64(statement, 10);
          if (!messageText.length && bodySize > 0) {
            messageText = attributed_text(sqlite3_column_blob(statement, 3), (NSUInteger)MAX(bodyBytes, 0));
            textStatus = messageText ? @"attributed" : @"unsupported";
          }
          if (!messageText && plainSize > 0) textStatus = @"unsupported";
          if ([textStatus isEqualToString:@"unsupported"]) complete = NO;
          BOOL truncated = messageText.length > 16000;
          id guid = sqlite_text(statement, 1), sender = sqlite_text(statement, 7), messageService = sqlite_text(statement, 8);
          NSDictionary *message = @{ @"messageId": sqlite_id(statement, 0), @"guid": [guid isKindOfClass:[NSString class]] ? clip(guid, 1024) : @"", @"text": messageText ? clip(messageText, 16000) : (id)[NSNull null], @"textStatus": textStatus, @"truncated": @(truncated), @"date": apple_date(statement, 5), @"fromMe": sqlite3_column_int(statement, 6) != 0 ? @YES : @NO, @"sender": [sender isKindOfClass:[NSString class]] ? clip(sender, 512) : (id)[NSNull null], @"service": [messageService isKindOfClass:[NSString class]] ? clip(messageService, 40) : @"", @"hasAttachments": sqlite3_column_int(statement, 9) != 0 ? @YES : @NO };
          [messages addObject:message];
          NSData *encoded = [NSJSONSerialization dataWithJSONObject:messages options:0 error:NULL];
          if (encoded.length > 120 * 1024 && messages.count > 1) { [messages removeLastObject]; more = YES; break; }
        }
        if (status != SQLITE_DONE && status != SQLITE_ROW) result = failure(@"connection_app_failed");
        else {
          NSMutableDictionary *data = [@{ @"messages": messages, @"chatId": chatId, @"hasMore": @(more), @"complete": @(complete) } mutableCopy];
          if (messages.count > 0) data[@"nextBefore"] = messages.lastObject[@"messageId"];
          result = success(data);
        }
      }
    }
  }
  if (statement) sqlite3_finalize(statement);
  sqlite3_close(database);
  return result ?: failure(@"connection_app_invalid_parameters");
}

static OSAScript *embedded_script(void) {
  return [[OSAScript alloc] initWithSource:[NSString stringWithUTF8String:MOCO_JXA_SOURCE] language:[OSALanguage languageForName:@"JavaScript"]];
}

static NSDictionary *automate(NSDictionary *request) {
  NSString *appId = request[@"appId"], *action = request[@"action"];
  NSString *appPath = [appId isEqualToString:@"messages"] ? @"/System/Applications/Messages.app" : @"/System/Applications/Mail.app";
  NSBundle *bundle = [NSBundle bundleWithPath:appPath];
  NSString *bundleId = bundle.bundleIdentifier;
  if (!bundleId) return failure(@"connection_app_unavailable");
  BOOL permission = [action isEqualToString:@"probe"] && [request[@"requestPermission"] isEqual:@YES];
  NSArray *running = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId];
  if (running.count == 0 && permission) {
    NSError *launchError = nil;
    NSRunningApplication *application = [[NSWorkspace sharedWorkspace] launchApplicationAtURL:[NSURL fileURLWithPath:appPath] options:NSWorkspaceLaunchWithoutActivation configuration:@{} error:&launchError];
    if (!application || launchError) return failure(@"connection_app_not_running");
  } else if (running.count == 0) return failure(@"connection_app_not_running");
  AEAddressDesc target = { typeNull, NULL };
  NSData *identifier = [bundleId dataUsingEncoding:NSUTF8StringEncoding];
  if (AECreateDesc(typeApplicationBundleID, identifier.bytes, identifier.length, &target) != noErr) return failure(@"connection_app_unavailable");
  __block OSStatus authorization = errAEEventNotPermitted;
  dispatch_semaphore_t finished = dispatch_semaphore_create(0);
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{ authorization = AEDeterminePermissionToAutomateTarget(&target, typeWildCard, typeWildCard, permission); dispatch_semaphore_signal(finished); });
  dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
  AEDisposeDesc(&target);
  if (authorization != noErr) return failure(authorization == procNotFound ? @"connection_app_not_running" : @"connection_app_automation_required");
  NSMutableDictionary *input = [request mutableCopy];
  input[@"bundleId"] = bundleId;
  NSData *inputData = [NSJSONSerialization dataWithJSONObject:input options:0 error:NULL];
  NSString *inputString = [[NSString alloc] initWithData:inputData encoding:NSUTF8StringEncoding];
  NSDictionary *error = nil;
  NSAppleEventDescriptor *reply = [embedded_script() executeHandlerWithName:@"moco" arguments:@[[NSAppleEventDescriptor descriptorWithString:inputString]] error:&error];
  if (!reply || error) {
    BOOL writing = [@[@"messages.send", @"mail.send", @"mail.draft"] containsObject:action];
    return failure(writing ? @"connection_app_delivery_unknown" : @"connection_app_failed");
  }
  NSString *json = reply.stringValue;
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id decoded = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
  if ([decoded isKindOfClass:[NSDictionary class]] && [decoded[@"mocoError"] isKindOfClass:[NSString class]]) return failure(decoded[@"mocoError"]);
  return [decoded isKindOfClass:[NSDictionary class]] ? success(decoded) : failure(@"connection_app_failed");
}

int main(int argc, const char **argv) {
  @autoreleasepool {
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) return 0;
    if (argc == 2 && strcmp(argv[1], "--validate-script") == 0) return [embedded_script() compileAndReturnError:NULL] ? 0 : 1;
    if (argc != 1) { emit(failure(@"connection_app_invalid_parameters")); return 0; }
    NSMutableData *input = [NSMutableData data];
    for (;;) {
      NSData *chunk = [[NSFileHandle fileHandleWithStandardInput] readDataOfLength:4096];
      if (chunk.length == 0) break;
      [input appendData:chunk];
      if (input.length > 256 * 1024) { emit(failure(@"connection_app_invalid_parameters")); return 0; }
    }
    NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:0 error:NULL];
    if (![request isKindOfClass:[NSDictionary class]] || ![@[@"messages", @"mail"] containsObject:request[@"appId"]] || ![request[@"action"] isKindOfClass:[NSString class]]) { emit(failure(@"connection_app_invalid_parameters")); return 0; }
    NSString *action = request[@"action"];
    if ([request[@"appId"] isEqualToString:@"messages"] && [@[@"messages.probe_read", @"messages.list", @"messages.read"] containsObject:action]) emit(messages_database(request));
    else if ([action isEqualToString:@"probe"] || ([request[@"appId"] isEqualToString:@"messages"] && [action isEqualToString:@"messages.send"]) || ([request[@"appId"] isEqualToString:@"mail"] && [@[@"mail.list", @"mail.read", @"mail.draft", @"mail.send"] containsObject:action])) emit(automate(request));
    else emit(failure(@"connection_app_invalid_parameters"));
    return 0;
  }
}
