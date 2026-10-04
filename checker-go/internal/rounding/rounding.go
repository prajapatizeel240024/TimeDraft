// Package rounding turns raw seconds into billed tenths of an hour, in integers.
package rounding

import (
	"errors"
	"fmt"
)

// ErrNotPositive is returned for zero or negative seconds: no entry is ever built from zero seconds.
var ErrNotPositive = errors.New("seconds must be a positive whole number")

// Tenths rounds seconds up to the next tenth of an hour: 1-360 s is 1, 361 s is 2.
func Tenths(seconds int) (int, error) {
	if seconds <= 0 {
		return 0, ErrNotPositive
	}
	return (seconds + 359) / 360, nil
}

// Hours formats tenths as hours: 12 is "1.2".
func Hours(tenths int) string {
	return fmt.Sprintf("%d.%d", tenths/10, tenths%10)
}
