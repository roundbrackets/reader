#/!/bin/bash

multipass stop reader
multipass delete reader
multipass purge
multipass launch --name reader --cpus 1 --memory 512M --disk 4G --network en0 20.04
multipass mount ./reader reader:/home/ubuntu/reader
multipass exec reader -- bash -c "cd reader && ./install.sh"
multipass exec reader -- bash -c "cd reader && nohup ./run.sh &"
multipass info reader
