import React, { useState, useEffect } from 'react';
import {
  Text,
  Heading,
  Flex,
  Box,
  Tag,
  Divider,
  Alert,
  LoadingSpinner,
  Button,
  hubspot,
} from '@hubspot/ui-extensions';


const BACKEND_BASE_URL = 'https://stockiq-n93y.onrender.com';

function getStatusInfo(requested, available, onHand, threshold) {
  if (onHand === null) return { label: 'Unknown', variant: 'default' };
  if (onHand === 0) return { label: 'Out of Stock', variant: 'error' };
  if (available !== null && available < requested) return { label: 'Insufficient', variant: 'error' };
  if (onHand < threshold) return { label: 'Low Stock', variant: 'warning' };
  return { label: 'In Stock', variant: 'success' };
}

hubspot.extend(({ context, actions }) => (
  <StockIQCard context={context} actions={actions} />
));

function StockIQCard({ context, actions }) {
  const [lineItems, setLineItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastSynced, setLastSynced] = useState(null);

  const portalId = String(context.portal.id);
  const dealId = String(context.crm.objectId);

  useEffect(() => {
    loadStockData();
  }, []);

  async function loadStockData() {
    setLoading(true);
    setError(null);

    try {
      const url = `${BACKEND_BASE_URL}/api/stock/${portalId}/deal-line-items/${dealId}`;
      const res = await hubspot.fetch(url);

      if (!res.ok) throw new Error(`${res.status} — portal:${portalId} deal:${dealId}`);

      const data = await res.json();
      setLineItems(data.lineItems || []);
      setLastSynced(new Date().toLocaleTimeString());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <Flex direction="column" align="center" gap="md">
        <LoadingSpinner label="Loading stock data…" />
      </Flex>
    );
  }

  if (error) {
    return (
      <Alert title="Error loading stock data" variant="error">
        {error}
      </Alert>
    );
  }

  const hasShortfall = lineItems.some(
    (item) => item.available !== null && item.requested > item.available
  );
  const hasReservations = lineItems.some((item) => item.reserved > 0);

  return (
    <Flex direction="column" gap="md">
      <Flex justify="between" align="center">
        <Heading>📦 Product Availability</Heading>
        <Button variant="secondary" size="small" onClick={loadStockData}>
          Refresh
        </Button>
      </Flex>

      {/* Banner */}
      {lineItems.length === 0 ? (
        <Alert title="No line items" variant="info">
          This deal has no line items with linked products.
        </Alert>
      ) : hasShortfall ? (
        <Alert title="Insufficient available stock" variant="error">
          One or more products don't have enough available stock for this deal.
          Stock may be reserved by other deals.
        </Alert>
      ) : hasReservations ? (
        <Alert title="Stock reserved for this deal" variant="success">
          All line items have sufficient stock. Some stock is reserved exclusively for this deal.
        </Alert>
      ) : (
        <Alert title="All products available" variant="success">
          All line items have sufficient stock on hand.
        </Alert>
      )}

      {/* Line items */}
      {lineItems.map((item, idx) => {
        const statusInfo = getStatusInfo(item.requested, item.available, item.stockOnHand, item.threshold ?? 10);
        const isReserved = item.reserved > 0;
        return (
          <Box key={item.hsProductId || idx}>
            {idx > 0 && <Divider />}
            <Flex direction="column" gap="xs">
              {/* Product name + status */}
              <Flex justify="between" align="center">
                <Text format={{ fontWeight: 'bold' }}>{item.name || 'Unknown Product'}</Text>
                <Flex gap="xs">
                  {isReserved && <Tag variant="info">Reserved</Tag>}
                  <Tag variant={statusInfo.variant}>{statusInfo.label}</Tag>
                </Flex>
              </Flex>

              {/* SKU */}
              <Text variant="microcopy" format={{ color: 'medium' }}>
                SKU: {item.sku || '—'}
              </Text>

              {/* Stock numbers */}
              <Flex gap="lg" wrap="wrap">
                <Flex direction="column" gap="extra-small">
                  <Text variant="microcopy" format={{ color: 'medium' }}>Requested</Text>
                  <Text format={{ fontWeight: 'bold' }}>{item.requested ?? '—'}</Text>
                </Flex>

                <Flex direction="column" gap="extra-small">
                  <Text variant="microcopy" format={{ color: 'medium' }}>On Hand</Text>
                  <Text format={{ fontWeight: 'bold' }}>{item.stockOnHand ?? '—'}</Text>
                </Flex>

                {item.reserved > 0 && (
                  <Flex direction="column" gap="extra-small">
                    <Text variant="microcopy" format={{ color: 'medium' }}>Reserved</Text>
                    <Text format={{ fontWeight: 'bold', color: 'medium' }}>{item.reserved}</Text>
                  </Flex>
                )}

                <Flex direction="column" gap="extra-small">
                  <Text variant="microcopy" format={{ color: 'medium' }}>Available</Text>
                  <Text
                    format={{
                      fontWeight: 'bold',
                      color:
                        item.available === 0
                          ? 'error'
                          : item.available !== null && item.available < item.requested
                          ? 'error'
                          : 'success',
                    }}
                  >
                    {item.available ?? '—'}
                  </Text>
                </Flex>
              </Flex>
            </Flex>
          </Box>
        );
      })}

      {/* Footer */}
      {lastSynced && (
        <Text variant="microcopy" format={{ color: 'medium' }}>
          Last synced: {lastSynced}
        </Text>
      )}
    </Flex>
  );
}
