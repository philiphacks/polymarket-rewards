# Polymarket - Market Making & Farming

## Main Strategy

### Main.js:
The main strategy farms the /rewards page and adds YES & NO bids within the midpoint range at the most conservative spread.

Hedging has to be done manually, e.g. if you get filled on a YES for X shares, you have to calculate the Y share amount for NO to buy (in order to hedge).

Go to https://polymarket.com/rewards?onlyOpenOrders=true&id=earning_percentage&desc=true&q= to see earnings.

NOTE: THIS STRATEGY LOSES MONEY

### Crypto.js:

Very opportunistically posts bids to buy UP/DOWN on 15-min crypto markets (only on Bitcoin 15-min atm).


## Tweets & Interesting Links

https://x.com/Marko_Poly/status/1988353305785802863
https://polymarket.com/@Halfapound?via=marko_poly

## Deployed on DO Droplet

`ssh root@178.62.213.122`

Run with
`pm2 start crypto.js --name polymarket-bot`
`pm2 start history.js --name prices-bot`

Stop
`pm2 stop polymarket-bot`
`pm2 stop prices-bot`

or if that doesn't work use `pm2 list` and use `pm2 stop <ID>`.
