from core.property_repository import save_property

test_property = {
    "source": "rightmove",
    "listing_id": "test-001",
    "title": "Test Property",
    "address": "123 Test Street, London",
    "price": 850000,
    "bedrooms": 3,
    "image_url": "https://example.com/image.jpg",
    "listing_url": "https://example.com/test-property-001",
    "status": "new",
}

response = save_property(test_property)

print(response)