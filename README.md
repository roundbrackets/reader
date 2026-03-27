Reader
======

Reader is a vibe coded web application that strips html elements such as ads and frames from an a webpage and converts it into **low vision friendly** format with sans serif fonts. While it will strip out ads because they overlay and distract, the purpose is for people with low vision to be able to use the fucking internet.

It works for both mobile browsers and desktop browsers.

Links are perserved.

The user can 
* adjust font size, page margins and line height to suit.
* download as PDF.

The user uses it by entering an url in a form.

Install & Use (on MacOS)
------------------------

### Install Multipass

You can certainly just run directly on your mac, but here is a way to run on a VM using multipass.

```
brew install --cask multipass

# List your networks, pick an interface you like
# Replace en0 if needed
multipass networks

# Launch a VM with bridged networking, any device on your network
# can use your service 
multipass launch --name reader --cpus 1 --memory 512M --disk 4G --network en0 20.04

# Copy the project into the VM
multipass transfer -r . reader:/home/ubuntu

# Here's your VM!
multipass info reader
```

### Install reader on VM & Launch

```
# Shell into the VM
multipass shell reader

# Inside the VM:
./install.sh
./run.sh
```

### Use the reader

```
multipass info reader   # Look for the second IP — that's the bridged LAN IP
```

Open `http://<vm-ip>:3000` in your browser on your local machine or any device on your network.

Multipass
---------

[Multipass](https://canonical.com/multipass) uses Hyper-V on Windows, QEMU on macOS and Linux to start Ubuntu VMs.

```
# Create a VM
multipass launch --name <name> --cpus 1 --memory 512M --disk 4G <ubuntu release>

# With networking
multipass launch --name reader --cpus 1 --memory 512M --disk 4G --network <interface> <release>

# Copy stuff onto the VM
multipass transfer -r <source> <name>:<dest>

multipass start <name>    # start VM
multipass stop <name>     # stop VM
multipass shell <name>	  # shell in
multipass list            # see all VMs and their status
multipass info <name>     # IP address, resource usage
multipass delete <name>   # delete the VM
multipass purge           # free disk space after deleting
```

Expose to your local network with socat instead
-----------------------------------------------

On your **Mac** (not inside the VM), open a new terminal:

```bash
# Install socat if needed
brew install socat

# Get the VM's IP
multipass info reader   # note the IPv4 address

# Forward your Mac's port 3000 to the VM
socat TCP-LISTEN:3000,bind=0.0.0.0,fork TCP:<vm-ip>:3000
```

Get your Mac's LAN IP:

```bash
ipconfig getifaddr en0
```

Open `http://<mac-lan-ip>:3000` on any device on your network (phone, tablet, etc.).

Keep the socat terminal open while you're using it. `Ctrl+C` to stop forwarding.

Final thought
-------------

Maybe don't expose to the internet?
