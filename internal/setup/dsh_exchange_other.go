//go:build !darwin && !linux

package setup

import "fmt"

func exchangeDSHDirectories(stage, dir string) error {
	return fmt.Errorf("atomic DSH directory refresh is unsupported on this platform; previous installation was preserved")
}
