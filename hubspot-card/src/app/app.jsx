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
  hubspot,
} from '@hubspot/ui-extensions';

const BACKEND_BASE_URL = 'https://your-app.onrender.com';

// Status badge config
function getStatusInfo(requested, onHand, threshold) {
  if (onHand === null) return { label: 'Unknown', variant: 'default' };
  if (onHand === 0) return { label: 'Out of Stock', variant: 'error' };
  if (onHand < threshold || requested > onHand) return { label: 'Low Stock', variant: 'warning' };
  return { label: 'In Stock', variant: 'success' };
}

hubspot.extend(({ context, runServerlessFunction, actions }) => (
  <StockIQCard context={context} runServerlessFunction={runServerlessFunction} actions={actions} />
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
      // Fetch deal associations to get line items via GraphQL
      const gqlResult = await actions.fetchCrmObjectProperties({
        objectType: 'deals',
        objectId: dealId,
        properties: ['dealname', 'dealstage'],
      });

      // Use serverless function (via fetch) to get line item stock
      // Since UI Extensions can call fetch to external URLs
      const assocRes = await fetch(
        `${BACKEND_BASE_URL}/api/stock/${portalId}/deal-line-items/${dealId}`,
        { headers: { 'Content-Type': 'application/json' } }
      );

      if (!assocRes.ok) {
        throw new Error(`Backend returned ${assocRes.status}`);
      }

      const data = await assocRes.json();
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

  const hasIssues = lineItems.some(
    (item) => item.stockOnHand === 0 || (item.stockOnHand !== null && item.requested > item.stockOnHand)
  );

  return (
    <Flex direction="column" gap="md">
      <Heading>📦 Product Availability</Heading>

      {/* Banner */}
      {lineItems.length === 0 ? (
        <Alert title="No line items" variant="info">
          This deal has no line items with linked products.
        </Alert>
      ) : hasIssues ? (
        <Alert title="⚠️ One or more products may have insufficient stock" variant="warning">
          Review the line items below before closing this deal.
        </Alert>
      ) : (
        <Alert title="✅ All products available" variant="success">
          All line items have sufficient stock on hand.
        </Alert>
      )}

      {/* Line items */}
      {lineItems.map((item, idx) => {
        const statusInfo = getStatusInfo(item.requested, item.stockOnHand, item.threshold ?? 10);
        return (
          <Box key={item.hsProductId || idx}>
            {idx > 0 && <Divider />}
            <Flex direction="column" gap="xs">
              <Flex justify="between" align="center">
                <Text format={{ fontWeight: 'bold' }}>{item.name || 'Unknown Product'}</Text>
                <Tag variant={statusInfo.variant}>{statusInfo.label}</Tag>
              </Flex>
              <Text variant="microcopy" format={{ color: 'medium' }}>
                SKU: {item.sku || '—'}
              </Text>
              <Flex gap="lg">
                <Text variant="microcopy">
                  Requested: <Text format={{ fontWeight: 'bold' }}>{item.requested ?? '—'}</Text>
                </Text>
                <Text variant="microcopy">
                  On Hand:{' '}
                  <Text
                    format={{
                      fontWeight: 'bold',
                      color: item.stockOnHand === 0 ? 'error' : item.stockOnHand < item.requested ? 'warning' : 'default',
                    }}
                  >
                    {item.stockOnHand ?? '—'}
                  </Text>
                </Text>
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
