# FoodUp Orders Backend

FoodUp Orders backend service.

## 1.0.1 resilience update
- Redis request timeout + retry + short circuit breaker.
- Async Express route errors return 503/500 instead of crashing Node.
- Root health endpoint stays alive during temporary Redis outages.
- Background monitor/auto-action promise safety.
- Reduced Redis command volume with MGET and atomic SET ... EX writes.


## Customer app tracking

The consolidated customer tracking endpoint is server-to-server only. Set `FOODUP_CUSTOMER_TRACKING_SECRET` to the same strong random value on this Orders backend and the FoodUp Customer Backend.
