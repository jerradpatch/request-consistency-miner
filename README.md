WIP

# request-consistency-miner
- This makes a request for the purpose of data mining consistant. It currently handles cases for:
-- black listing of IP address (via proxy)
-- Ip usage limits/back off

For example, a remote server has black listed an Ip that was used to make a request, we will never use that IP again.
Black listing is attempted to be prevented by using Ip usage limits. Where a timelimit is set on an IP address before
it can be used again.

For proxying we use the Tor exit nodes.
