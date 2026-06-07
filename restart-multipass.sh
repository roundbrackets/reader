#!/bin/bash

  sudo launchctl stop com.canonical.multipassd
  sudo launchctl start com.canonical.multipassd
sudo launchctl list com.canonical.multipassd
sudo launchctl print system/com.canonical.multipassd
