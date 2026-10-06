const AUTO_ACTION_STALE_TTL_SECONDS = 30 * 24 * 60 * 60;

function isPermanentMissingOrderResponse(wpResponse, wpResult) {
  const status = Number(wpResponse?.status || 0);
  const code = String(wpResult?.code || '').trim().toLowerCase();
  return status === 404 && code === 'order_not_found';
}

async function handleAutoActionWordPressFailure({
  redisCommand,
  k,
  code,
  orderId,
  action,
  wpResponse,
  wpResult,
  logger = console,
}) {
  if (!isPermanentMissingOrderResponse(wpResponse, wpResult)) return false;

  // WordPress is authoritative for order existence. Stop the minute-loop for a
  // stale backend order without marking it accepted/rejected or sending pushes.
  await redisCommand(
    'SET',
    k(code, `auto_actioned:${orderId}`),
    'yes',
    'EX',
    AUTO_ACTION_STALE_TTL_SECONDS
  );

  logger.warn?.(
    `[auto-action] stopped ${action} retries for ${code}/${orderId}: wordpress_order_not_found`
  );
  return true;
}

module.exports = {
  AUTO_ACTION_STALE_TTL_SECONDS,
  isPermanentMissingOrderResponse,
  handleAutoActionWordPressFailure,
};
