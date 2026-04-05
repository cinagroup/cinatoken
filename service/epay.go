package service

import (
	"github.com/cinagroup/cinatoken/setting/operation_setting"
	"github.com/cinagroup/cinatoken/setting/system_setting"
)

func GetCallbackAddress() string {
	if operation_setting.CustomCallbackAddress == "" {
		return system_setting.ServerAddress
	}
	return operation_setting.CustomCallbackAddress
}
