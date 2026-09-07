import os

RUNTIME_UID = 10001
RUNTIME_GID = 10001


def drop_runtime_privileges() -> None:
    if os.geteuid() == RUNTIME_UID and os.getegid() == RUNTIME_GID:
        return
    if os.geteuid() != 0:
        raise RuntimeError("CLaMP3 runtime cannot establish the required non-root identity")
    os.setgroups([])
    os.setresgid(RUNTIME_GID, RUNTIME_GID, RUNTIME_GID)
    os.setresuid(RUNTIME_UID, RUNTIME_UID, RUNTIME_UID)
    os.umask(0o077)
    if (
        os.getresuid() != (RUNTIME_UID, RUNTIME_UID, RUNTIME_UID)
        or os.getresgid() != (RUNTIME_GID, RUNTIME_GID, RUNTIME_GID)
    ):
        raise RuntimeError("CLaMP3 runtime privilege drop did not persist")