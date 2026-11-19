#include <errno.h>
#include <libproc.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

/* These are the same Seatbelt query SPI used by sandbox-exec's runtime. */
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
extern const int SANDBOX_CHECK_NO_REPORT;

static int marker_name(const char *name) {
  size_t length = strlen(name);
  if (length < 24 || length > 160) return 0;
  for (size_t index = 0; index < length; index++) {
    char value = name[index];
    if ((value < 'a' || value > 'z') && (value < '0' || value > '9') && value != '.' && value != '-') return 0;
  }
  return 1;
}

static int belongs(pid_t pid, const char *marker, const char *negative, struct proc_bsdinfo *info) {
  errno = 0;
  int size = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, info, sizeof(*info));
  if (size != sizeof(*info)) {
    if (size == 0 && (errno == ESRCH || errno == ENOENT)) return 0;
    int metadata_error = errno;
    errno = 0;
    int exists = kill(pid, 0), existence_error = errno;
    if (exists < 0 && existence_error == ESRCH) return 0;
    fprintf(stderr, "Cannot inspect sandbox process metadata: pid=%d errno=%d bytes=%d exists=%d existence_errno=%d\n", pid, metadata_error, size, exists, existence_error);
    return -1;
  }
  if (info->pbi_uid != geteuid()) return 0;
  if (sandbox_check(pid, NULL, 0) != 1) return 0;
  int flags = 2 | SANDBOX_CHECK_NO_REPORT; /* SANDBOX_FILTER_GLOBAL_NAME */
  if (sandbox_check(pid, "mach-lookup", flags, marker) != 0) return 0;
  /* Unsandboxed hosts and unrelated broad profiles must never match just the positive canary. */
  return sandbox_check(pid, "mach-lookup", flags, negative) == 1 ? 1 : 0;
}

static int members(const char *marker, const char *negative, pid_t **result) {
  int length = proc_listpids(PROC_UID_ONLY, geteuid(), NULL, 0);
  if (length <= 0) { fprintf(stderr, "Cannot size process membership list: errno=%d bytes=%d\n", errno, length); return -1; }
  int capacity = length * 2 + 4096;
  pid_t *pids = calloc(1, (size_t)capacity);
  if (!pids) return -1;
  length = proc_listpids(PROC_UID_ONLY, geteuid(), pids, capacity);
  if (length < 0 || length >= capacity) { fprintf(stderr, "Cannot read process membership list: errno=%d bytes=%d capacity=%d\n", errno, length, capacity); free(pids); return -1; }
  int count = 0;
  for (int index = 0; index < length / (int)sizeof(pid_t); index++) {
    if (pids[index] <= 0) continue;
    struct proc_bsdinfo info;
    int match = belongs(pids[index], marker, negative, &info);
    if (match < 0) { free(pids); return -1; }
    if (match) pids[count++] = pids[index];
  }
  *result = pids;
  return count;
}

static int scoped_signal(pid_t pid, int value, const char *marker, const char *negative) {
  struct proc_bsdinfo before, current;
  int match = belongs(pid, marker, negative, &before);
  if (match <= 0) return match;
  match = belongs(pid, marker, negative, &current);
  if (match <= 0) return match;
  if (before.pbi_start_tvsec != current.pbi_start_tvsec || before.pbi_start_tvusec != current.pbi_start_tvusec) return 0;
  if (kill(pid, value) == 0 || errno == ESRCH) return 1;
  fprintf(stderr, "Cannot signal sandbox member: pid=%d errno=%d\n", pid, errno);
  return -1;
}

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--probe") == 0) {
    /* An unconfined controller must see its own query as allowed. */
    return sandbox_check(getpid(), NULL, 0) == 0 ? 0 : 2;
  }
  if (argc < 4) return 2;
  const char *marker = argv[argc - 2], *negative = argv[argc - 1];
  if (!marker_name(marker) || !marker_name(negative) || strcmp(marker, negative) == 0) return 2;
  if (argc == 5 && strcmp(argv[1], "--verify") == 0) {
    char *end = NULL;
    long value = strtol(argv[2], &end, 10);
    if (!end || *end || value <= 0 || value > INT32_MAX) return 2;
    struct proc_bsdinfo info;
    int match = belongs((pid_t)value, marker, negative, &info);
    return match == 1 ? 0 : match == 0 ? 1 : 2;
  }
  if (argc != 4 || strcmp(argv[1], "--cleanup") != 0) return 2;
  int empty = 0;
  /* Membership is a kernel policy property, so reparenting and setsid do not leave this boundary. */
  for (int attempt = 0; attempt < 250; attempt++) {
    pid_t *pids = NULL;
    int count = members(marker, negative, &pids);
    if (count < 0) { empty = 0; usleep(20000); continue; }
    if (count == 0) {
      free(pids);
      if (++empty == 3) return 0;
    } else {
      empty = 0;
      /* Stop forkers before killing; each following pass also catches children born during the snapshot. */
      for (int index = 0; index < count; index++) scoped_signal(pids[index], SIGSTOP, marker, negative);
      for (int index = 0; index < count; index++) scoped_signal(pids[index], SIGKILL, marker, negative);
      free(pids);
    }
    usleep(20000);
  }
  return 3;
}
