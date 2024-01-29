package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Memory struct {
	MemTotal     int
	MemFree      int
	MemAvailable int
}

func (m Memory) ToStr() string {
	return fmt.Sprintf("MEMORY:\nTotal: %.3f GB\nFree: %.3f GB\nAvailable: %.3f GB", float64(m.MemTotal)/1000000, float64(m.MemFree)/1000000, float64(m.MemAvailable)/1000000)
}

func ReadMemoryStats() Memory {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		panic(err)
	}
	defer file.Close()
	bufio.NewScanner(file)
	scanner := bufio.NewScanner(file)
	res := Memory{}
	for scanner.Scan() {
		key, value := parseLine(scanner.Text())
		switch key {
		case "MemTotal":
			res.MemTotal = value
		case "MemFree":
			res.MemFree = value
		case "MemAvailable":
			res.MemAvailable = value
		}
	}
	return res
}

func parseLine(raw string) (key string, value int) {
	text := strings.ReplaceAll(raw[:len(raw)-2], " ", "")
	keyValue := strings.Split(text, ":")
	return keyValue[0], toInt(keyValue[1])
}

func toInt(raw string) int {
	if raw == "" {
		return 0
	}
	res, err := strconv.Atoi(raw)
	if err != nil {
		panic(err)
	}
	return res
}
