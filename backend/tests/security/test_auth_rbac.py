from backend.app.core.permissions import UserRole
from backend.app.core.security import create_access_token


from backend.app.models.user import User


def test_public_verifier_cannot_create_batches(client, db):
    user = User(
        username="verifier_test",
        email="verifier@test.io",
        hashed_password="hashed_pw",
        full_name="Verifier",
        role=UserRole.PUBLIC_VERIFIER,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    verifier_token = create_access_token(
        data={"sub": user.id, "username": user.username, "role": user.role.value}
    )
    headers = {"Authorization": f"Bearer {verifier_token}"}

    res = client.post(
        "/api/v1/batches",
        json={
            "batch_code": "FORBIDDEN",
            "component_type": "DISPLAY",
            "planned_quantity": 10,
            "supplier_id": "sup-01",
            "facility_id": "fac-01",
        },
        headers=headers,
    )
    # Must reject with 403 Forbidden
    assert res.status_code == 403


def test_unauthenticated_request_rejected(client):
    res = client.post(
        "/api/v1/batches",
        json={
            "batch_code": "NOAUTH",
            "component_type": "DISPLAY",
            "planned_quantity": 10,
            "supplier_id": "sup-01",
            "facility_id": "fac-01",
        },
    )
    assert res.status_code == 401
