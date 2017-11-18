WIP

# Request-Consistency-Miner
- This makes a request, for the purpose of data mining, consistant given remote server anti-mining tactics. We use tor exit nodes for proxying requests.

## anti-tactics we handle / Features Provided:
-- Ip Blacklisting
-- Ip usage limit/back off
-- Resource request reduction
-- Set headers + auto Randomize userAgent header


### Definitions:
black listing - black listed an Ip that was used to make a request, we will never use that IP again.
Black listing is attempted to be prevented by using Ip usage limits. 

Ip usage limits/back off - uWhere a timelimit is set on an IP address before it can be used again.

Resource request reduction - cache the requested URL's to a set time limit, serving the originally fetched page until that time limit expires.                          
