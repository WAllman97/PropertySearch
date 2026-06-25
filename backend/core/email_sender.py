import os
import resend
from dotenv import load_dotenv

load_dotenv()

resend.api_key = os.getenv("RESEND_API_KEY")


def send_email(subject: str, html_body: str, recipients: list[str]):
    if not resend.api_key:
        raise ValueError("RESEND_API_KEY is missing")

    if not recipients:
        print("No recipients provided. Email not sent.")
        return

    response = resend.Emails.send({
        "from": os.getenv("FROM_EMAIL"),
        "to": recipients,
        "subject": subject,
        "html": html_body,
    })

    print("Email sent via Resend:", response)
    return response