package setup

import "golang.org/x/sys/unix"

func exchangeDSHDirectories(stage, dir string) error {
	return unix.Renameat2(unix.AT_FDCWD, stage, unix.AT_FDCWD, dir, unix.RENAME_EXCHANGE)
}
