      });
      req.on('end', () => {
        try {
          const input: PreferencesUpdateInput = JSON.parse(body);
          if (!input || typeof input.categories !== 'object') {
            logger.warn('PUT /api/preferences/:userId invalid body', {
              requestId,
              correlationId,
              userId,
            });
            sendErr(
              res,
              400,
              'Invalid body: expected { categories: { [key]: boolean } }',
              ErrorCode.BAD_REQUEST,
            );
            return;
          }
          const updated = preferenceStore.update(userId, input);
          logger.info('PUT /api/preferences/:userId complete', {
            requestId,
            correlationId,
            userId,
            durationMs: Date.now() - startTime,
          });
          sendOk(res, 200, updated);
        } catch {
          logger.error('PUT /api/preferences/:userId invalid JSON', {
            requestId,
            correlationId,
            userId,
          });
          sendErr(res, 400, 'Invalid JSON', ErrorCode.PARSE_ERROR);
        }
      });
      return;
    }

    // GET /api/archive, GET /api/archive/:id, POST /api/archive/run
    if (
      options.archiveStore &&
      (url.pathname === '/api/archive' || url.pathname.startsWith('/api/archive/'))
    ) {
      const handled = await handleArchiveRequest(
        req,
        res,
        {
          store: options.archiveStore,
          service: options.archiveService,
        },
        requestId,
      );
      if (handled) return;
    }

    // GET /api/notifications/delivery-metrics and /history  (Issue #482)
    const deliveryMetricsHandled = handleDeliveryMetricsRequest(
      req,
      res,
      url,
      {
        analyticsAggregator: options.analyticsAggregator,
        metricsStore: options.metricsStore,
      },
      { requestId, correlationId, startTime },
    );
    if (deliveryMetricsHandled) return;

    // GET /api/metrics/response-time — expose response-time counters (#491)
    if (req.method === 'GET' && url.pathname === '/api/metrics/response-time') {
      const metrics = responseTime.getMetrics();
      const reset = url.searchParams.get('reset') === 'true';
      sendOk(res, 200, metrics);
      if (reset) {
        responseTime.resetMetrics();
        logger.info('Response-time metrics reset', { requestId });
      }
      return;
    }

    logger.warn('Unhandled request', {
      requestId,
      correlationId,
      method: req.method,
      url: req.url,
    });
    sendErr(res, 404, 'Not found', ErrorCode.NOT_FOUND);
    responseTime.finish(req, res, requestId, 404);
  };

  const server = http.createServer((req, res) => {
    // Request-ID + correlation middleware (#686, #986): assigns (or
    // validates+reuses) a requestId and correlationId, stamps both onto the
    // response headers, and runs the handler inside an AsyncLocalStorage
    // context so logs, error envelopes and queued jobs inherit them.
    runWithRequestCorrelation(req, res, (requestContext) =>
      handleRequest(req, res, requestContext),
    ).catch((error: unknown) => {
      logger.error('Unhandled error in events server request handler', { error });
      if (!res.headersSent) {
        sendErr(res, 500, 'Internal server error', ErrorCode.INTERNAL_ERROR);
      } else {
        res.end();
      }
    });
  });

  if (rateLimiter) {
    const originalClose = server.close.bind(server);
    server.close = (callback?: (err?: Error) => void) => {
      rateLimiter.destroy();
      return originalClose(callback);
    };
  }

  return server;
}

export function startEventsServer(options: EventsServerOptions): http.Server {
  const server = createEventsServer(options);
  server.listen(options.port, () => {
    logger.info('Events API server listening', { port: options.port });
  });
  return server;
}
