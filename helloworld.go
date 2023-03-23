package testdata

import logger "github.com/kubescape/go-logger"

const str string = "Hello world!"

func helloWorld() string {
	logger.L().Info(str)
	return str
}
