package setup

import "golang.org/x/sys/unix"

func exchangeDSHDirectories(stage, dir string) error {
	return unix.RenamexNp(stage, dir, unix.RENAME_SWAP)
}
