package testdata

import "testing"

func Test_helloWorld(t *testing.T) {
	tests := []struct {
		name string
		want string
	}{
		{"test func", str},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := helloWorld(); got != tt.want {
				t.Errorf("helloWorld() = %v, want %v", got, tt.want)
			}
		})
	}
}
