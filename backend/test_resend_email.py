from core.emailer import send_daily_email

test_properties = [
    {
        "price": "£625,000",
        "address": "Nevis Road, Balham",
        "reason": "Matches your search",
        "search_name": "Balham 3-bed houses",
        "source": "Rightmove",
        "url": "https://www.rightmove.co.uk/",
        "image": "",
    }
]

send_daily_email(test_properties)